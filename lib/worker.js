/**
 * Private recognition process. The Host passes the configuration and resolved model paths as JSON in
 * argv[2] and a bearer secret in DSH_SPEECH_TOKEN. Once the model is loaded, the process listens on an
 * ephemeral loopback port and prints `{"port":N}` + newline as its only stdout output.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { postProcess } from "./postprocess.js";

class SpeechInputError extends Error {}

/** Validate canonical 16 kHz mono PCM16 WAV and return its duration in seconds. */
function validateWave(audio, maxBytes) {
	if (audio.byteLength > maxBytes) throw new SpeechInputError("Speech audio exceeds the worker byte limit");
	if (audio.byteLength < 44) throw new SpeechInputError("Invalid speech WAV: too short");
	const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
	const tag = (offset) => String.fromCharCode(...audio.subarray(offset, offset + 4));
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") throw new SpeechInputError("Invalid speech WAV header");
	const format = view.getUint16(20, true), channels = view.getUint16(22, true);
	const rate = view.getUint32(24, true), bits = view.getUint16(34, true), dataBytes = view.getUint32(40, true);
	if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) throw new SpeechInputError("Speech WAV must be 16 kHz mono PCM16");
	if (dataBytes !== audio.byteLength - 44 || dataBytes % 2 !== 0) throw new SpeechInputError("Inconsistent speech WAV length");
	return dataBytes / 32000;
}

function createTranscriber(config) {
	const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
	const { family, files } = config.model;
	const modelConfig = { tokens: files.tokens, numThreads: config.threads, provider: "cpu", debug: 0 };
	if (family === "whisper") {
		modelConfig.whisper = { encoder: files.encoder, decoder: files.decoder, language: "", task: "transcribe", tailPaddings: -1 };
	} else if (family === "nemo-transducer") {
		modelConfig.transducer = { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner };
		modelConfig.modelType = "nemo_transducer";
	} else if (family === "moonshine") {
		modelConfig.moonshine = {
			preprocessor: files.preprocessor,
			encoder: files.encoder,
			uncachedDecoder: files.uncachedDecoder,
			cachedDecoder: files.cachedDecoder
		};
	} else {
		throw new Error(`Unsupported model family: ${family}`);
	}
	const nativeConfig = { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig, decodingMethod: "greedy_search" };
	const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
	const detector = new sherpa.Vad({
		sileroVad: {
			model: config.vad,
			threshold: config.vadThreshold,
			minSilenceDuration: config.minSilenceSeconds,
			minSpeechDuration: config.minSpeechSeconds,
			maxSpeechDuration: config.segmentSeconds,
			windowSize: 512
		},
		sampleRate: 16000,
		numThreads: config.threads,
		provider: "cpu",
		debug: 0
	}, config.segmentSeconds + config.minSilenceSeconds + 1);

	let lastWhisperKey = "|transcribe";
	return (audio, language) => {
		if (!config.model.languages.includes(language)) throw new SpeechInputError(`Unsupported language for this model: ${language}`);
		const audioSeconds = validateWave(audio, config.maxAudioBytes);
		const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
		const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);

		if (family === "whisper") {
			const task = config.translateToEnglish && config.model.translate ? "translate" : "transcribe";
			const key = `${language === "auto" ? "" : language}|${task}`;
			if (key !== lastWhisperKey) {
				modelConfig.whisper.language = language === "auto" ? "" : language;
				modelConfig.whisper.task = task;
				recognizer.setConfig(nativeConfig);
				lastWhisperKey = key;
			}
		}

		detector.reset();
		const started = performance.now(), texts = [];
		const onsetPadding = Math.round(config.vadOnsetPaddingSeconds * 16000);
		let isFirstSegment = true;
		const drain = () => {
			while (!detector.isEmpty()) {
				const segment = detector.front(false);
				let speech = segment.samples;
				if (isFirstSegment) {
					isFirstSegment = false;
					const from = Math.max(0, segment.start - onsetPadding);
					if (from < segment.start) {
						const restored = new Float32Array(segment.start - from + speech.length);
						restored.set(samples.subarray(from, segment.start));
						restored.set(speech, segment.start - from);
						speech = restored;
					}
				}
				const stream = recognizer.createStream();
				stream.acceptWaveform({ sampleRate: 16000, samples: speech });
				recognizer.decode(stream);
				texts.push(recognizer.getResult(stream).text.trim());
				detector.pop();
			}
		};
		for (let offset = 0; offset < samples.length; offset += 512) {
			detector.acceptWaveform(samples.subarray(offset, offset + 512));
			drain();
		}
		detector.flush();
		drain();
		const raw = texts.filter(Boolean).join(" ").trim();
		return {
			text: postProcess(raw, language, config),
			audioSeconds,
			inferenceSeconds: (performance.now() - started) / 1000
		};
	};
}

async function startServer(token, maxAudioBytes, transcribe) {
	const expected = Buffer.from(`Bearer ${token}`);
	const server = createServer((request, response) => {
		const reply = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
		const authorization = Buffer.from(request.headers.authorization ?? "");
		if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
			request.resume();
			return reply(401, { error: "Unauthorized" });
		}
		const url = new URL(request.url, "http://localhost");
		if (request.method !== "POST" || url.pathname !== "/transcribe") {
			request.resume();
			return reply(404, { error: "Unknown endpoint" });
		}
		const length = Number(request.headers["content-length"]);
		if (!Number.isSafeInteger(length) || length < 46 || length > maxAudioBytes) {
			request.resume();
			return reply(413, { error: "Invalid speech audio size", code: "invalid-input" });
		}
		(async () => {
			try {
				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				reply(200, transcribe(Buffer.concat(chunks), url.searchParams.get("language") ?? "auto"));
			} catch (error) {
				reply(error instanceof SpeechInputError ? 400 : 500, {
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof SpeechInputError ? { code: "invalid-input" } : {})
				});
			}
		})();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return server.address().port;
}

async function main() {
	const config = JSON.parse(process.argv[2]);
	const token = process.env.DSH_SPEECH_TOKEN;
	if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Missing worker token");
	delete process.env.DSH_SPEECH_TOKEN;
	const port = await startServer(token, config.maxAudioBytes, createTranscriber(config));
	process.stdout.write(`${JSON.stringify({ port })}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
});
