/**
 * dsh-local-voice: registers one local speech provider per selected model (Whisper, Parakeet, Moonshine
 * or a custom sherpa-onnx model) with DeepSeek Harness's experimental speech-to-text registry.
 *
 * Derived from @deepseek-ai/dsh-experimental-speech-to-text-sensevoice (MIT, Copyright (c) 2026 DeepSeek).
 * Activation only inspects disk caches; models are downloaded when the user prepares a provider.
 */
import { isAbsolute, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { CATALOG, FAMILY_FILES, VAD } from "./catalog.js";

export const name = "dsh-local-voice";
export const inject = ["speechToText", "subprocess"];

const MAX_TIMER = 2 ** 31 - 1;
const ORIGIN = /^https?:\/\/[^/\s?#@]+\/?$/;

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

const CustomModel = Schema.object({
	id: Schema.string().pattern(/^[a-z0-9][a-z0-9-]*$/).required().description("Unique id (lowercase letters, digits, dashes)."),
	name: Schema.string().required().description("Name shown in the model picker."),
	family: Schema.union(["whisper", "nemo-transducer", "moonshine"]).required().description("sherpa-onnx model family."),
	directory: Schema.string().required().description("Absolute directory containing the ONNX files."),
	files: Schema.dict(String).required().description("Role → file name (encoder, decoder, joiner, tokens, preprocessor, uncachedDecoder, cachedDecoder)."),
	languages: Schema.array(String).default(["auto"]).description("Accepted language hints; put 'auto' first."),
	translate: Schema.boolean().default(false).description("The model can translate speech into English (multilingual Whisper).")
});

export const Config = Schema.object({
	providerPrefix: Schema.string().pattern(/^[a-z0-9-]+$/).default("local").description("Prefix of the registered provider ids (e.g. local-whisper-small)."),
	dataRoot: Schema.string().required().description("Absolute directory where models are stored."),
	models: Schema.array(Schema.union(Object.keys(CATALOG))).role("checkbox")
		.default(["parakeet-v3", "whisper-small", "whisper-turbo"])
		.description("Catalog models offered in the voice-input model picker. Nothing is downloaded until a model is prepared."),
	customModels: Schema.array(CustomModel).default([]).description("sherpa-onnx models already on disk."),
	translateToEnglish: Schema.boolean().default(false).description("Whisper: translate speech into English instead of transcribing it."),
	removeFillerWords: Schema.boolean().default(false).description("Remove filler words (um, uh, euh, hum…)."),
	customWords: Schema.array(String).default([]).description("Custom words (names, jargon): close matches in the transcript are corrected to them."),
	customWordThreshold: Schema.number().min(0).max(0.5).default(0.25).description("Fuzzy-match tolerance (share of differing letters)."),
	replacements: Schema.dict(String).default({}).description("Exact whole-word, case-insensitive replacements (e.g. 'new line' → a line break)."),
	modelOrigins: Schema.array(Schema.string().pattern(ORIGIN)).default(["https://huggingface.co", "https://hf-mirror.com"])
		.description("Hugging Face-compatible origins; the fastest responder is tried first, the others as fallback."),
	modelProbeTimeoutMs: Schema.natural().min(1).max(MAX_TIMER).default(3000),
	threads: Schema.natural().min(1).default(4).description("CPU threads per model."),
	segmentSeconds: Schema.number().min(1).max(30).default(28).description("Maximum speech segment length (Whisper: ≤ 30 s)."),
	vadThreshold: Schema.number().min(0).max(1).default(0.5),
	minSpeechSeconds: Schema.number().min(0).default(0.25),
	minSilenceSeconds: Schema.number().min(0.01).default(0.5),
	vadOnsetPaddingSeconds: Schema.number().min(0).max(1).default(0.3),
	maxAudioBytes: Schema.natural().min(46).default(16 * 1024 * 1024).description("Maximum recording size (16 MB ≈ 8 min)."),
	prepareTimeoutMs: Schema.natural().min(1).max(MAX_TIMER).default(2 * 3600e3),
	inferenceTimeoutMs: Schema.natural().min(1).max(MAX_TIMER).default(300e3),
	idleTimeoutMs: Schema.natural().max(MAX_TIMER).default(300e3).description("Unload the model after this much inactivity (0 = never)."),
	maxPending: Schema.natural().min(1).default(4),
	graceMs: Schema.natural().min(1).max(MAX_TIMER).default(1000),
	maxLogBytes: Schema.natural().min(1).default(64 * 1024),
	maxResponseBytes: Schema.natural().min(1).default(512 * 1024),
	progressIntervalMs: Schema.natural().min(1).max(MAX_TIMER).default(100)
});

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

class SpeechInputError extends Error {}

class SpeechDownloadError extends Error {
	constructor(download, options) {
		super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}${download.code ? ` (${download.code})` : ""}${download.status === undefined ? "" : ` (HTTP ${download.status})`}`, options);
		this.download = download;
	}
}

class TimeoutReason extends Error {}

/** Abort signal that fires on the upstream signal or after `ms`; call dispose() to clear the timer. */
function deadline(upstream, ms, code) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new TimeoutReason(code)), Math.min(ms, MAX_TIMER));
	const signal = AbortSignal.any([upstream, controller.signal]);
	return { signal, dispose: () => clearTimeout(timer) };
}

const timedOut = (signal) => signal.aborted && signal.reason instanceof TimeoutReason;

const FAILURE_CODES = [
	["dns", /^(ENOTFOUND|EAI_AGAIN)$/],
	["timeout", /^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/],
	["certificate", /^(CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/],
	["storage", /^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/],
	["network", /^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/]
];

function classifyDownloadFailure(failure) {
	const pending = [failure], seen = new Set();
	let reason = "unknown";
	while (pending.length) {
		const error = pending.shift();
		if (!(error instanceof Error) || seen.has(error)) continue;
		seen.add(error);
		if (error instanceof TimeoutReason || error.name === "TimeoutError") return { reason: "timeout" };
		if (typeof error.code === "string") {
			for (const [kind, pattern] of FAILURE_CODES) if (pattern.test(error.code)) return { reason: kind, code: error.code };
		}
		if (error instanceof TypeError && error.message === "fetch failed") reason = "network";
		pending.push(error.cause);
		if (error instanceof AggregateError) pending.push(...error.errors);
	}
	return { reason };
}

function waitFor(pending, signal) {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Speech operation cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

// ---------------------------------------------------------------------------------------------
// Verified downloads
// ---------------------------------------------------------------------------------------------

async function matchesAsset(path, asset, signal) {
	signal.throwIfAborted();
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`Speech asset is not a regular file: ${path}`);
		if (info.size !== asset.bytes) return false;
		const digest = createHash("sha256");
		for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
		return digest.digest("hex") === asset.sha256;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return false;
	}
}

/** Probe mirrors with HEAD and put the first responder first; keep the others for fallback. */
async function orderSources(assetUrl, origins, timeoutMs, signal) {
	signal.throwIfAborted();
	const path = new URL(assetUrl).pathname;
	const urls = [...new Set(origins.map((origin) => new URL(path, origin).href))];
	if (urls.length === 1) return urls;
	const probe = deadline(signal, timeoutMs, "SPEECH_SOURCE_PROBE_TIMEOUT");
	const finished = new AbortController();
	const probing = AbortSignal.any([probe.signal, finished.signal]);
	const requests = urls.map(async (url) => ({ url, response: await fetch(url, { method: "HEAD", signal: probing }) }));
	let preferred;
	try {
		preferred = await Promise.any(requests.map(async (request) => {
			const { url, response } = await request;
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return url;
		}));
	} catch {
		// every probe failed: keep the configured order
	} finally {
		finished.abort();
		probe.dispose();
		const settled = await Promise.allSettled(requests);
		await Promise.allSettled(settled.map(async (r) => { if (r.status === "fulfilled") await r.value.response.body?.cancel(); }));
	}
	signal.throwIfAborted();
	return preferred === undefined ? urls : [preferred, ...urls.filter((url) => url !== preferred)];
}

async function downloadAsset(asset, root, signal, report) {
	signal.throwIfAborted();
	const destination = join(root, asset.name);
	const partial = `${destination}.${randomUUID()}.part`;
	let source = new URL(asset.url).origin;
	try {
		await mkdir(root, { recursive: true });
		if (await matchesAsset(destination, asset, signal)) return destination;
		try {
			const response = await fetch(asset.url, { signal });
			source = new URL(response.url || asset.url).origin;
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new SpeechDownloadError({ resource: asset.name, source, reason: "http", status: response.status });
			}
			const digest = createHash("sha256");
			let completedBytes = 0;
			const publish = () => report({ phase: "downloading", resource: asset.name, completedBytes, totalBytes: asset.bytes });
			publish();
			const hashing = new Transform({
				transform(chunk, _encoding, callback) {
					completedBytes += chunk.length;
					if (completedBytes > asset.bytes) return callback(new SpeechDownloadError({ resource: asset.name, source, reason: "integrity" }));
					digest.update(chunk);
					publish();
					callback(null, chunk);
				}
			});
			await pipeline(response.body, hashing, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
			if (completedBytes !== asset.bytes || digest.digest("hex") !== asset.sha256) {
				throw new SpeechDownloadError({ resource: asset.name, source, reason: "integrity" });
			}
			signal.throwIfAborted();
			await rename(partial, destination);
			return destination;
		} finally {
			await rm(partial, { force: true });
		}
	} catch (error) {
		const expired = timedOut(signal);
		if ((signal.aborted && !expired) || error instanceof SpeechDownloadError) throw error;
		throw new SpeechDownloadError({ resource: asset.name, source, ...(expired ? { reason: "timeout" } : classifyDownloadFailure(error)) }, { cause: error });
	}
}

// ---------------------------------------------------------------------------------------------
// Model runtime layout
// ---------------------------------------------------------------------------------------------

/**
 * Describe where a model's files live and which of them are managed (downloaded and hash-checked).
 * @returns {{ managed: Array<[string, object]>, paths: Record<string,string>, vad: string, worker: string, modelRoot?: string }}
 */
function layout(config, model) {
	const vad = join(config.dataRoot, "models", "silero", VAD.name);
	const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
	if (model.directory) {
		const paths = Object.fromEntries(FAMILY_FILES[model.family].map((role) => [role, join(model.directory, model.files[role])]));
		return { managed: [], paths, vad, worker };
	}
	const modelRoot = join(config.dataRoot, "models", model.id);
	const managed = Object.entries(model.files).map(([role, asset]) => [role, asset]);
	const paths = Object.fromEntries(managed.map(([role, asset]) => [role, join(modelRoot, asset.name)]));
	return { managed, paths, vad, worker, modelRoot };
}

async function verifyRuntime(config, model, signal) {
	const { managed, paths, vad, worker, modelRoot } = layout(config, model);
	try {
		await Promise.all([...Object.values(paths), vad].map((path) => access(path)));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	}
	for (const [, asset] of managed) if (!await matchesAsset(join(modelRoot, asset.name), asset, signal)) return undefined;
	if (!await matchesAsset(vad, VAD, signal)) return undefined;
	signal.throwIfAborted();
	return { files: paths, vad, worker };
}

async function prepareRuntime(config, model, origins, signal, report) {
	const { managed, modelRoot } = layout(config, model);
	const download = async (asset, root, step) => {
		if (await matchesAsset(join(root, asset.name), asset, signal)) return;
		const urls = await orderSources(asset.url, origins, config.modelProbeTimeoutMs, signal);
		for (const [index, url] of urls.entries()) {
			try {
				await downloadAsset({ ...asset, url }, root, signal, (state) => report({ ...state, step }));
				return;
			} catch (error) {
				if (signal.aborted || !(error instanceof SpeechDownloadError) || ["storage", "unknown"].includes(error.download.reason) || index === urls.length - 1) throw error;
			}
		}
	};
	if (managed.length) {
		report({ phase: "checking", step: "model", startedAt: Date.now() });
		for (const [, asset] of managed) await download(asset, modelRoot, "model");
	}
	report({ phase: "checking", step: "vad", startedAt: Date.now() });
	await download(VAD, join(config.dataRoot, "models", "silero"), "vad");
	report({ phase: "checking", step: "verify", startedAt: Date.now() });
	const runtime = await verifyRuntime(config, model, signal);
	if (!runtime) throw new Error("Speech model verification failed: missing or corrupted model files");
	return runtime;
}

// ---------------------------------------------------------------------------------------------
// Worker process ownership (one serial worker per model)
// ---------------------------------------------------------------------------------------------

async function readReady(handle, limit, signal) {
	if (!handle.stdout) throw new Error("Speech worker stdout is unavailable");
	signal.throwIfAborted();
	const stdout = handle.stdout;
	let text = "";
	const pending = Promise.withResolvers();
	const data = (chunk) => {
		text += chunk.toString("utf8");
		if (Buffer.byteLength(text) > limit) return pending.reject(new Error("Speech worker readiness exceeded its byte limit"));
		const end = text.indexOf("\n");
		if (end < 0) return;
		try {
			const { port } = JSON.parse(text.slice(0, end));
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
			pending.resolve(port);
		} catch (error) {
			pending.reject(new Error("Invalid speech worker readiness", { cause: error }));
		}
	};
	stdout.on("data", data);
	stdout.on("error", pending.reject);
	handle.done.then(() => pending.reject(new Error(`Speech worker exited before readiness: ${handle.collected.stderr?.readFrom(0).text}`)), pending.reject);
	try {
		return await waitFor(pending.promise, signal);
	} finally {
		stdout.off("data", data);
		stdout.off("error", pending.reject);
		stdout.resume();
	}
}

async function readTranscript(response, limit) {
	if (!response.body) throw new Error("Speech worker returned no response");
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > limit) throw new Error("Speech transcript exceeded its byte limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!response.ok) {
		if ((response.status === 400 || response.status === 413) && value.code === "invalid-input") throw new SpeechInputError(String(value.error));
		throw new Error(String(value.error ?? `Speech worker failed with HTTP ${response.status}`));
	}
	if (typeof value.text !== "string" || !(value.audioSeconds >= 0) || !(value.inferenceSeconds >= 0)) throw new Error("Malformed speech worker response");
	return { text: value.text, audioSeconds: value.audioSeconds, inferenceSeconds: value.inferenceSeconds };
}

class ModelWorker {
	tail = Promise.resolve();
	pending = 0;
	lifetime = new AbortController();
	listeners = new Set();
	lastProgressAt = 0;

	constructor(ctx, config, model) {
		this.ctx = ctx;
		this.config = config;
		this.model = model;
		this.downloadSources = model.directory ? [] : [...new Set(config.modelOrigins.map((origin) => new URL(origin).origin))];
		const kinds = ["check", ...(model.directory ? [] : ["model"]), "vad", "verify", "load"];
		this.state = { phase: "unprepared", steps: kinds.map((kind) => ({ kind, status: "pending" })) };
	}

	snapshot() {
		return this.state;
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publish(state) {
		if (this.preparing && ["ready", "standby", "unprepared", "failed", "cancelled"].includes(state.phase)) this.preparing.completed = true;
		const previous = this.state;
		const steps = state.steps ?? previous.steps.map((item) => {
			if (state.phase === "ready") return { ...item, status: "complete" };
			if (state.step === "check" && item.kind !== "check") return { kind: item.kind, status: "pending" };
			if (state.step === item.kind) return item.status === "running" ? item : { kind: item.kind, status: "running", startedAt: Date.now() };
			if (item.status !== "running") return item;
			if (state.phase === "standby") return { ...item, status: "cancelled" };
			if (state.phase === "failed" || state.phase === "cancelled") return { ...item, status: state.phase };
			return state.step === undefined ? item : { ...item, status: "complete" };
		});
		this.state = { ...state, steps };
		const now = performance.now();
		if (state.phase === "downloading" && previous.phase === "downloading" && state.resource === previous.resource
			&& state.completedBytes !== state.totalBytes && now - this.lastProgressAt < this.config.progressIntervalMs) return;
		this.lastProgressAt = now;
		for (const listener of this.listeners) listener();
	}

	/** Check disk caches on activation without downloading or loading anything. */
	inspect() {
		this.runPreparation(async (signal) => {
			const inspection = deadline(signal, this.config.prepareTimeoutMs, "SPEECH_PREPARE_TIMEOUT");
			try {
				this.publish({ phase: "checking", step: "check", startedAt: Date.now() });
				const runtime = await verifyRuntime(this.config, this.model, inspection.signal);
				inspection.signal.throwIfAborted();
				this.runtime = runtime;
				this.publish({
					phase: runtime ? "standby" : "unprepared",
					steps: this.state.steps.map(({ kind }) => ({ kind, status: kind === "check" || (runtime && kind !== "load") ? "complete" : "pending" }))
				});
			} finally {
				inspection.dispose();
			}
		});
	}

	prepare(options = {}) {
		const source = options.downloadSource;
		if (source !== undefined && !this.downloadSources.includes(source)) throw new Error("Speech download source is unavailable");
		const origins = source === undefined ? this.config.modelOrigins : [source];
		this.runPreparation(async (signal) => { await this.start(signal, origins); }, source);
	}

	runPreparation(run, downloadSource) {
		if (this.preparing && this.preparing.downloadSource !== downloadSource) throw new Error("Cancel preparation before changing its download source");
		if (this.preparing || this.worker) return;
		this.lifetime.signal.throwIfAborted();
		const abort = new AbortController();
		const task = { abort, settled: Promise.resolve(), completed: false, downloadSource };
		this.preparing = task;
		task.settled = this.enqueue(run, abort.signal).catch((error) => {
			if (this.lifetime.signal.aborted) return;
			this.publish(abort.signal.aborted ? { phase: "cancelled" } : {
				phase: "failed",
				message: error instanceof Error ? error.message : String(error),
				...(error instanceof SpeechDownloadError ? { download: error.download } : {})
			});
		}).finally(() => { this.preparing = undefined; });
	}

	async cancel() {
		const task = this.preparing;
		if (!task) return;
		if (!task.completed) {
			this.publish({ phase: "cancelling", startedAt: Date.now() });
			task.abort.abort(new Error("Speech preparation cancelled"));
		}
		await task.settled;
	}

	async transcribe(input, signal) {
		return await this.enqueue(async (combined) => await this.execute(input, combined), signal);
	}

	async enqueue(run, signal) {
		const combined = AbortSignal.any([signal, this.lifetime.signal]);
		combined.throwIfAborted();
		if (this.pending >= this.config.maxPending) throw new Error("Speech transcription queue is full");
		clearTimeout(this.idle);
		this.pending++;
		const job = this.tail.then(async () => {
			combined.throwIfAborted();
			return await run(combined);
		});
		this.tail = job.then(() => undefined, () => undefined).finally(() => {
			this.pending--;
			if (this.pending === 0 && !this.lifetime.signal.aborted && this.config.idleTimeoutMs > 0) {
				this.idle = setTimeout(() => {
					this.tail = this.tail.then(async () => { await this.stop(); });
					this.tail.catch((error) => this.ctx.logger.warn("Speech worker idle cleanup failed", error));
				}, this.config.idleTimeoutMs);
			}
		});
		return await job;
	}

	async start(signal, origins = this.config.modelOrigins) {
		if (this.worker?.closed) await this.stop();
		if (this.worker) return this.worker;
		const setup = deadline(signal, this.config.prepareTimeoutMs, "SPEECH_PREPARE_TIMEOUT");
		try {
			const cached = this.runtime !== undefined;
			if (!cached) this.publish({ phase: "checking", step: "check", startedAt: Date.now() });
			const runtime = this.runtime ?? await prepareRuntime(this.config, this.model, origins, setup.signal, (state) => this.publish(state));
			this.runtime = runtime;
			setup.signal.throwIfAborted();
			this.publish({ phase: cached ? "waking" : "loading", step: "load", startedAt: Date.now() });
			await mkdir(this.config.dataRoot, { recursive: true });
			const token = randomBytes(32).toString("hex");
			const workerConfig = {
				...this.config,
				model: { family: this.model.family, languages: this.model.languages, translate: !!this.model.translate, files: runtime.files },
				vad: runtime.vad
			};
			const handle = this.ctx.subprocess.spawn({
				argv: [process.execPath, runtime.worker, JSON.stringify(workerConfig)],
				cwd: this.config.dataRoot,
				graceMs: this.config.graceMs,
				env: { DSH_SPEECH_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" },
				stdio: { stdin: "ignore", stdout: "pipe", stderr: { maxBytes: this.config.maxLogBytes } }
			});
			try {
				const worker = { handle, url: `http://127.0.0.1:${await readReady(handle, this.config.maxLogBytes, setup.signal)}`, token, closed: false };
				this.worker = worker;
				this.publish({ phase: "ready" });
				const exited = () => {
					if (!worker.closed) {
						worker.closed = true;
						this.publish({ phase: "standby" });
					}
				};
				handle.done.then(exited, exited);
				return worker;
			} catch (error) {
				handle.terminate();
				await handle.waitForExit();
				throw error;
			}
		} finally {
			setup.dispose();
		}
	}

	async execute(input, signal) {
		const phase = this.state.phase;
		if (phase !== "ready" && phase !== "standby") throw new Error("Prepare this speech model before recording");
		try {
			const worker = await this.start(signal);
			const call = deadline(signal, this.config.inferenceTimeoutMs, "SPEECH_INFERENCE_TIMEOUT");
			try {
				const response = await fetch(`${worker.url}/transcribe?language=${encodeURIComponent(input.language)}`, {
					method: "POST",
					headers: { authorization: `Bearer ${worker.token}`, "content-type": "audio/wav" },
					body: Buffer.from(input.audio),
					signal: call.signal
				});
				const result = await readTranscript(response, this.config.maxResponseBytes).catch((error) => {
					call.signal.throwIfAborted();
					throw error;
				});
				call.signal.throwIfAborted();
				return result;
			} finally {
				call.dispose();
			}
		} catch (error) {
			if (error instanceof SpeechInputError) throw error;
			await this.stop();
			this.publish({ phase: "standby" });
			throw error;
		}
	}

	async stop() {
		const worker = this.worker;
		if (!worker) return;
		worker.closed = true;
		worker.handle.terminate();
		await worker.handle.waitForExit();
		this.worker = undefined;
		this.publish({ phase: "standby" });
	}

	async dispose() {
		this.listeners.clear();
		this.lifetime.abort(new Error("Local voice provider disposed"));
		clearTimeout(this.idle);
		try {
			await this.tail;
		} finally {
			await this.stop();
		}
		await this.preparing?.settled;
	}
}

// ---------------------------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------------------------

function diskBytes(model) {
	if (model.directory) return 0;
	return Object.values(model.files).reduce((sum, file) => sum + file.bytes, VAD.bytes);
}

function resolveModels(config) {
	const models = config.models.map((id) => ({ id, ...CATALOG[id] }));
	for (const custom of config.customModels) {
		if (!isAbsolute(custom.directory)) throw new Error(`Custom model directory must be absolute: ${custom.directory}`);
		for (const role of FAMILY_FILES[custom.family]) {
			if (!custom.files[role]) throw new Error(`Custom model ${custom.id} needs a "${role}" file for family ${custom.family}`);
		}
		models.push({ ...custom, languages: custom.languages.length ? custom.languages : ["auto"], memoryBytes: 2e9 });
	}
	const ids = new Set();
	for (const model of models) {
		if (ids.has(model.id)) throw new Error(`Duplicate local voice model id: ${model.id}`);
		ids.add(model.id);
	}
	return models;
}

export function apply(ctx, config) {
	if (!isAbsolute(config.dataRoot)) throw new Error(`dataRoot must be absolute: ${config.dataRoot}`);
	for (const origin of config.modelOrigins) new URL(origin);
	for (const model of resolveModels(config)) {
		const worker = new ModelWorker(ctx, config, model);
		const disk = diskBytes(model);
		ctx.effect(() => {
			const unregister = ctx.speechToText.register({
				info: {
					id: `${config.providerPrefix}-${model.id}`,
					name: model.name,
					location: "host-local",
					languages: model.languages,
					downloadSources: worker.downloadSources,
					setupEstimate: {
						recommendedDiskBytes: Math.round(disk * 1.1),
						expectedMemoryBytes: model.memoryBytes,
						minimumMinutes: Math.max(1, Math.round(disk / 50e6 / 60)),
						maximumMinutes: Math.max(5, Math.round(disk / 2e6 / 60))
					}
				},
				preparation: worker,
				transcribe: async (input, signal) => await worker.transcribe(input, signal)
			});
			worker.inspect();
			return async () => {
				const removing = unregister();
				await worker.dispose();
				await removing;
			};
		});
	}
}
