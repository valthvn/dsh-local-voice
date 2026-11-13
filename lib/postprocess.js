/**
 * Text clean-up applied after recognition, inside the worker process:
 * filler-word removal, exact replacements, then fuzzy correction toward custom words.
 */

/** Hesitations removed when `removeFillerWords` is on. Matched as whole words, case-insensitively. */
const FILLERS = {
	fr: ["euh", "euhh", "heu", "hum", "bah", "ben", "hein"],
	en: ["um", "umm", "uh", "uhh", "erm", "er", "hmm", "mm"],
	es: ["eh", "em", "este"],
	de: ["äh", "ähm", "öh", "hm"],
	it: ["ehm", "eh", "mmm"],
	pt: ["é", "hum", "ahn"]
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = "[\\p{L}\\p{N}'’-]";
const wholeWord = (text, flags = "giu") => new RegExp(`(?<!${WORD})${escape(text)}(?!${WORD})`, flags);

function removeFillers(text, language) {
	const words = language in FILLERS ? FILLERS[language] : Object.values(FILLERS).flat();
	let out = text;
	for (const word of words) out = out.replace(new RegExp(`(?<!${WORD})${escape(word)}(?!${WORD})[,.…]*\\s*`, "giu"), "");
	return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Levenshtein distance bounded by `max`; returns max + 1 when exceeded. */
function distance(a, b, max) {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			best = Math.min(best, current[j]);
		}
		if (best > max) return max + 1;
		previous = current;
	}
	return previous[b.length];
}

const fold = (text) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Replace word sequences that sound or look close to a custom word (names, jargon, brands).
 * A window of the same number of words is compared after lowercasing and accent folding.
 */
function correctCustomWords(text, customWords, threshold) {
	if (customWords.length === 0) return text;
	// Even indexes are words, odd indexes the exact whitespace between them (kept as-is).
	const parts = text.split(/(\s+)/);
	const words = parts.filter((_, i) => i % 2 === 0);
	const gaps = parts.filter((_, i) => i % 2 === 1);
	const replaced = new Map(); // start word index -> { span, text }
	const used = new Set();
	for (const target of customWords) {
		const folded = fold(target).replace(/[^\p{L}\p{N}]/gu, "");
		const max = Math.floor(folded.length * threshold);
		if (folded.length < 4) continue;
		const targetSpan = target.trim().split(/\s+/).length;
		// The recognizer may split or merge words: "deep seek" for "DeepSeek".
		for (let span = Math.max(1, targetSpan - 1); span <= targetSpan + 2; span++) {
			for (let i = 0; i + span <= words.length; i++) {
				if ([...Array(span).keys()].some((k) => used.has(i + k))) continue;
				const window = words.slice(i, i + span).join(" ");
				const core = window.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
				if (!core || core.includes("\n")) continue;
				const candidate = fold(core).replace(/[^\p{L}\p{N}]/gu, "");
				if (candidate === folded && core === target) continue;
				if (distance(candidate, folded, max) <= max) {
					const prefix = window.match(/^[^\p{L}\p{N}]*/u)[0];
					const suffix = window.match(/[^\p{L}\p{N}]*$/u)[0];
					replaced.set(i, { span, text: `${prefix}${target}${suffix}` });
					for (let k = 0; k < span; k++) used.add(i + k);
				}
			}
		}
	}
	let out = "";
	for (let i = 0; i < words.length; i++) {
		const hit = replaced.get(i);
		if (hit) {
			out += hit.text;
			i += hit.span - 1;
		} else {
			out += words[i];
		}
		if (i < gaps.length) out += gaps[i];
	}
	return out;
}

/**
 * @param {string} text - raw recognizer output.
 * @param {string} language - language hint of the recording.
 * @param {{removeFillerWords:boolean, replacements:Record<string,string>, customWords:string[], customWordThreshold:number}} options
 * @returns {string} cleaned text.
 */
export function postProcess(text, language, options) {
	let out = text;
	if (options.removeFillerWords) out = removeFillers(out, language);
	for (const [from, to] of Object.entries(options.replacements ?? {})) {
		if (from.trim()) out = out.replace(wholeWord(from.trim()), to);
	}
	out = correctCustomWords(out, options.customWords ?? [], options.customWordThreshold);
	return out.replace(/[ \t]*\n[ \t]*/g, "\n").trim();
}
