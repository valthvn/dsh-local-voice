/**
 * Built-in model catalog. Every file is pinned to a Hugging Face commit with its exact size and
 * SHA-256, so a download from any mirror is verified before use.
 */

const asset = (repo, revision, name, bytes, sha256) => ({
	name,
	url: `https://huggingface.co/${repo}/resolve/${revision}/${name}`,
	bytes,
	sha256
});

/** Languages Whisper was trained on (ISO 639-1 where available). */
export const WHISPER_LANGUAGES = [
	"en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi",
	"fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
	"mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy",
	"ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
	"tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl",
	"mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue"
];

/** Parakeet TDT v3 detects these 25 European languages automatically. */
export const PARAKEET_V3_LANGUAGES = [
	"bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt",
	"ro", "sk", "sl", "es", "sv", "ru", "uk"
];

const PARAKEET = ["csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "ed5d745623472f97cfc2e6c2916ee248798fc5a8"];
const WHISPER_TOKENS_SHA = "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126";

const whisper = (size, revision, encoder, decoder, extra = {}) => {
	const repo = `csukuangfj/sherpa-onnx-whisper-${size}`;
	return {
		family: "whisper",
		languages: ["auto", ...WHISPER_LANGUAGES],
		files: {
			encoder: asset(repo, revision, `${size}-encoder.int8.onnx`, ...encoder),
			decoder: asset(repo, revision, `${size}-decoder.int8.onnx`, ...decoder),
			tokens: asset(repo, revision, `${size}-tokens.txt`, 816730, WHISPER_TOKENS_SHA)
		},
		...extra
	};
};

/**
 * @typedef {object} CatalogModel
 * @property {string} name - display name shown in the provider picker.
 * @property {"whisper"|"nemo-transducer"|"moonshine"} family - sherpa-onnx recognizer family.
 * @property {string[]} languages - accepted language hints ("auto" first).
 * @property {Record<string, {name:string,url:string,bytes:number,sha256:string}>} files - roles to pinned assets.
 * @property {boolean} [translate] - whether the model can translate speech into English.
 * @property {number} memoryBytes - rough resident memory estimate while loaded.
 */

/** @type {Record<string, CatalogModel>} */
export const CATALOG = {
	"parakeet-v3": {
		name: "Parakeet TDT 0.6B v3 (25 European languages, fast)",
		family: "nemo-transducer",
		languages: ["auto", ...PARAKEET_V3_LANGUAGES],
		memoryBytes: 1.5e9,
		files: {
			encoder: asset(...PARAKEET, "encoder.int8.onnx", 652282294, "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479"),
			decoder: asset(...PARAKEET, "decoder.int8.onnx", 11845274, "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5"),
			joiner: asset(...PARAKEET, "joiner.int8.onnx", 6355277, "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98"),
			tokens: asset(...PARAKEET, "tokens.txt", 93939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d")
		}
	},
	"whisper-tiny": {
		name: "Whisper Tiny (99 languages, smallest)",
		memoryBytes: 0.4e9,
		...whisper("tiny", "65176e2deb88badc814a94058666cadccc29b61c",
			[12937772, "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"],
			[89855401, "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"], { translate: true })
	},
	"whisper-base": {
		name: "Whisper Base (99 languages, light)",
		memoryBytes: 0.6e9,
		...whisper("base", "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
			[29120534, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"],
			[130672026, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"], { translate: true })
	},
	"whisper-small": {
		name: "Whisper Small (99 languages, balanced)",
		memoryBytes: 1.2e9,
		...whisper("small", "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
			[112442483, "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"],
			[262226114, "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"], { translate: true })
	},
	"whisper-medium": {
		name: "Whisper Medium (99 languages, accurate)",
		memoryBytes: 2.5e9,
		...whisper("medium", "8c31d28503847560985df21f90e14f0c736e075e",
			[374196283, "1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e"],
			[571059257, "595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747"], { translate: true })
	},
	"whisper-turbo": {
		name: "Whisper Large v3 Turbo (99 languages, accurate and fast)",
		memoryBytes: 2.8e9,
		...whisper("turbo", "2ca6ff69fc878651b770880507669577ac41c2ff",
			[674716297, "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b"],
			[361080764, "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547"])
	},
	"whisper-large-v3": {
		name: "Whisper Large v3 (99 languages, most accurate, slow)",
		memoryBytes: 4.5e9,
		...whisper("large-v3", "2a6507094dd6020d939d78e3f1834a1d06267fca",
			[766671985, "d531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85"],
			[1008265203, "ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af"], { translate: true })
	},
	"moonshine-base-en": {
		name: "Moonshine Base (English only, very fast)",
		family: "moonshine",
		languages: ["auto", "en"],
		memoryBytes: 0.6e9,
		files: (() => {
			const repo = ["csukuangfj/sherpa-onnx-moonshine-base-en-int8", "052b0798ad1bf046a140fdd4efcd9426530fa3f5"];
			return {
				preprocessor: asset(...repo, "preprocess.onnx", 14077290, "ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2"),
				encoder: asset(...repo, "encode.int8.onnx", 50311494, "7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2"),
				uncachedDecoder: asset(...repo, "uncached_decode.int8.onnx", 122120451, "c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987"),
				cachedDecoder: asset(...repo, "cached_decode.int8.onnx", 99983837, "2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03"),
				tokens: asset(...repo, "tokens.txt", 436688, "1165c2aeb9f72f457a83be2d459a09054f27490acd9b41bd43794dfd25e296ea")
			};
		})()
	}
};

/** Silero VAD, shared by every model. */
export const VAD = asset("csukuangfj/vad", "fba88cd2e921609e7675c3aaf51e0b9b295da4bc", "silero_vad.onnx", 1807522,
	"a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28");

/** File roles each recognizer family needs. */
export const FAMILY_FILES = {
	"whisper": ["encoder", "decoder", "tokens"],
	"nemo-transducer": ["encoder", "decoder", "joiner", "tokens"],
	"moonshine": ["preprocessor", "encoder", "uncachedDecoder", "cachedDecoder", "tokens"]
};
