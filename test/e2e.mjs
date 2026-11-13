/**
 * End-to-end smoke test outside DeepSeek Harness: fakes the `speechToText` registry and `subprocess`
 * services, prepares one model (real download + SHA-256 check), then transcribes a WAV file.
 *
 *   node test/e2e.mjs <model-id> <file.wav> <language> <dataRoot>
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as plugin from "../lib/index.js";

const [modelId = "whisper-tiny", wavPath, language = "auto", dataRoot] = process.argv.slice(2);
if (!wavPath || !dataRoot) throw new Error("usage: node test/e2e.mjs <model-id> <file.wav> <language> <dataRoot>");

/** Re-pack any PCM16 mono 16 kHz WAV (possibly with extra chunks) into the canonical 44-byte header form. */
function canonicalWave(bytes) {
	let offset = 12, data;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
		if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
		offset += 8 + size + (size % 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
	header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
	header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
	header.write("data", 36); header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

const providers = [];
const effects = [];
const ctx = {
	logger: { warn: console.warn },
	effect: (fn) => effects.push(fn()),
	speechToText: { register: (provider) => { providers.push(provider); return async () => {}; } },
	subprocess: {
		spawn({ argv, cwd, env, stdio }) {
			const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (c) => { stderr += c; });
			const done = new Promise((resolve) => child.on("exit", resolve));
			return {
				stdout: child.stdout,
				done,
				collected: { stderr: { readFrom: () => ({ text: stderr }) } },
				terminate: () => child.kill(),
				waitForExit: () => done
			};
		}
	}
};

plugin.apply(ctx, plugin.Config({ dataRoot, models: [modelId], removeFillerWords: true, customWords: ["DeepSeek Harness"] }));
const provider = providers[0];
console.log("provider:", provider.info.id, "-", provider.info.name, `(${provider.info.languages.length} languages)`);

const settle = () => new Promise((resolve) => {
	const check = () => {
		const { phase } = provider.preparation.snapshot();
		if (["ready", "standby", "unprepared", "failed", "cancelled"].includes(phase)) return resolve(provider.preparation.snapshot());
		setTimeout(check, 200);
	};
	check();
});

let last = "";
provider.preparation.subscribe(() => {
	const s = provider.preparation.snapshot();
	const line = s.phase === "downloading" ? `downloading ${s.resource} ${Math.round(100 * s.completedBytes / s.totalBytes)}%` : s.phase;
	if (line !== last && (!line.startsWith("downloading") || line.endsWith("0%"))) console.log("  ", line);
	last = line;
});

console.log("after inspect:", (await settle()).phase);
await new Promise((r) => setTimeout(r, 100)); // let the inspection task release its slot
provider.preparation.prepare();
await new Promise((r) => setTimeout(r, 300));
const prepared = await settle();
console.log("after prepare:", prepared.phase, prepared.message ?? "");
if (prepared.phase === "failed") process.exit(1);

const audio = canonicalWave(readFileSync(wavPath));
const result = await provider.transcribe({ audio, language }, new AbortController().signal);
console.log("RESULT:", JSON.stringify(result));
await Promise.all(effects.map((dispose) => dispose()));
