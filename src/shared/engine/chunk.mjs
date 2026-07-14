/**
 * The markdown chunker. PURE, deterministic, locale-independent.
 *
 * The plugins chunk; the sidecar is a dumb embed-and-store (DESIGN 6.4). Every
 * Second Read plugin therefore writes into ONE shared index, and a chunk is
 * identified by the FNV-1a-64 hash of its normalized text — so if two plugins
 * chunked the same note even slightly differently they would embed the same
 * prose twice under different keys and the index would silently become
 * incoherent. That is why this file is canonical, vendored byte-identical, and
 * drift-checked by `npm test` in every repo. DO NOT "improve" the algorithm in a
 * plugin repo: any change here invalidates every stored chunk id on earth and
 * forces a full re-embed.
 *
 * Algorithm (DESIGN 6.4), in order:
 *   1. Strip YAML frontmatter.
 *   2. Fenced code blocks longer than CODE_INLINE_MAX_CHARS become `[code]`;
 *      shorter ones stay inline. `$$…$$` math blocks are stripped.
 *   3. Split on ATX headings; carry a `>`-joined H1..H6 breadcrumb.
 *   4. Within a section, greedily accumulate paragraphs to targetChars; hard-break
 *      at maxChars on the nearest sentence boundary; a continuing chunk is prefixed
 *      with the last overlapChars of the previous one.
 *   5. Drop chunks under minChars unless the note has only one.
 *   6. key = fnv1a64(normalizeChunkText(text)) — 16 hex chars.
 */
import { fnv1a64 } from "../hash.mjs";

export const DEFAULT_CHUNK_OPTIONS = Object.freeze({
	targetChars: 900,
	maxChars: 1400,
	minChars: 120,
	overlapChars: 150,
});

/** A fenced block longer than this is not worth embedding; it becomes the literal `[code]`. */
export const CODE_INLINE_MAX_CHARS = 400;

/** The two index namespaces the sidecar knows (DESIGN 6.2). */
export const CHUNK_NS = Object.freeze({ NOTES: "notes", QUESTIONS: "questions" });

const BOM = /^\uFEFF/;
const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\r?\n([\s\S]*?)(?:\r?\n\1?\2`*~*[ \t]*(?=\r?\n|$)|$)/;
const FENCE_MARKER = /^[ \t]{0,3}(`{3,}|~{3,})/;
const MATH_BLOCK = /\$\$[\s\S]*?\$\$/g;
const ATX_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*)$/;

/**
 * The text a chunk key is computed over: lowercased, punctuation runs collapsed to a
 * single space, whitespace collapsed. Two chunks that differ only in trailing
 * punctuation, heading markers or line wrapping are the SAME chunk and must not be
 * embedded twice.
 */
export function normalizeChunkText(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The 16-hex-char id of a chunk's text. */
export function chunkKey(text) {
	return fnv1a64(normalizeChunkText(text));
}

function normalizeOptions(opts) {
	const o = opts ?? {};
	const targetChars = positive(o.targetChars, DEFAULT_CHUNK_OPTIONS.targetChars);
	const overlapChars = Math.max(0, integer(o.overlapChars, DEFAULT_CHUNK_OPTIONS.overlapChars));
	const maxChars = Math.max(targetChars, positive(o.maxChars, DEFAULT_CHUNK_OPTIONS.maxChars));
	const minChars = Math.max(0, integer(o.minChars, DEFAULT_CHUNK_OPTIONS.minChars));
	// A unit plus its overlap prefix plus the "\n\n" joiner must still fit under maxChars,
	// so that no emitted chunk can ever exceed the hard cap.
	const unitLimit = Math.max(1, maxChars - overlapChars - 2);
	return { targetChars, maxChars, minChars, overlapChars, unitLimit };
}

function positive(value, fallback) {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function integer(value, fallback) {
	return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** Step 1 + 2: frontmatter, code fences, math. */
function prepare(markdown) {
	// A BOM would otherwise sit in front of the `---` and defeat the frontmatter strip.
	let text = String(markdown ?? "")
		.replace(BOM, "")
		.replace(/\r\n/g, "\n");
	text = text.replace(FRONTMATTER, "");

	// Walk the fences rather than regex-replacing globally: a fence's body may itself
	// contain `#` lines that must NOT be read as headings.
	let out = "";
	let rest = text;
	for (;;) {
		const at = rest.search(/^[ \t]{0,3}(`{3,}|~{3,})/m);
		if (at === -1) break;
		const match = FENCE.exec(rest.slice(at));
		if (!match) break;
		out += rest.slice(0, at);
		const body = match[4] ?? "";
		out += body.length > CODE_INLINE_MAX_CHARS ? "[code]" : match[0];
		rest = rest.slice(at + match[0].length);
	}
	out += rest;

	return out.replace(MATH_BLOCK, " ");
}

/** Step 3: sections, each with its `>`-joined heading breadcrumb. */
function splitSections(text) {
	const sections = [];
	const trail = [];
	let heading = "";
	let body = [];

	const flush = () => {
		const joined = body.join("\n").trim();
		if (joined.length > 0) sections.push({ heading, text: joined });
		body = [];
	};

	// Short fenced blocks survive step 2 verbatim, so a `# comment` inside one would
	// otherwise open a section. Track the fence and never read a heading inside it.
	let fence = null;

	for (const line of text.split("\n")) {
		const f = FENCE_MARKER.exec(line);
		if (fence !== null) {
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
			body.push(line);
			continue;
		}
		if (f) {
			fence = f[1];
			body.push(line);
			continue;
		}

		const m = ATX_HEADING.exec(line);
		if (!m) {
			body.push(line);
			continue;
		}
		flush();
		const level = m[1].length;
		const title = m[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
		trail.length = level - 1;
		for (let i = 0; i < level - 1; i++) if (trail[i] === undefined) trail[i] = "";
		trail[level - 1] = title;
		heading = trail.filter((t) => t !== undefined && t !== "").join(" > ");
	}
	flush();

	return sections;
}

/** The nearest sentence boundary at or before `limit`; falls back to a word break, then a hard cut. */
function sentenceCut(text, limit) {
	const window = text.slice(0, limit);
	const sentence = /[.!?…][)"'\]»]?(?=\s|$)/g;
	let cut = -1;
	let m;
	while ((m = sentence.exec(window)) !== null) cut = m.index + m[0].length;
	if (cut > 0) return cut;
	const space = window.search(/\s(?=\S*$)/);
	if (space > 0) return space;
	return limit;
}

/** Split a single over-long paragraph into sentence-bounded units, each <= limit. */
function splitLongUnit(text, limit) {
	const out = [];
	let rest = text;
	while (rest.length > limit) {
		const cut = Math.max(1, sentenceCut(rest, limit));
		const head = rest.slice(0, cut).trim();
		if (head.length > 0) out.push(head);
		rest = rest.slice(cut).trim();
	}
	if (rest.length > 0) out.push(rest);
	return out;
}

/** The last <= overlapChars of `text`, snapped forward to a word boundary. */
function overlapPrefix(text, overlapChars) {
	if (overlapChars <= 0 || text.length === 0) return "";
	const tail = text.slice(-overlapChars);
	const space = tail.search(/\s/);
	const snapped = space === -1 ? tail : tail.slice(space + 1);
	return snapped.trim();
}

/** Step 4: greedy pack with a hard cap and an overlap carry. */
function packSection(sectionText, opts) {
	const units = [];
	for (const para of sectionText.split(/\n{2,}/)) {
		const trimmed = para.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length > opts.unitLimit) units.push(...splitLongUnit(trimmed, opts.unitLimit));
		else units.push(trimmed);
	}

	const chunks = [];
	let cur = "";

	const begin = (unit) => {
		const carry = chunks.length > 0 ? overlapPrefix(chunks[chunks.length - 1], opts.overlapChars) : "";
		return carry.length > 0 ? carry + "\n\n" + unit : unit;
	};

	for (const unit of units) {
		if (cur.length === 0) {
			cur = begin(unit);
			continue;
		}
		const merged = cur + "\n\n" + unit;
		// Merge past the target only to rescue a chunk that would otherwise be dropped
		// for being under minChars — and never past the hard cap.
		const rescue = cur.length < opts.minChars && merged.length <= opts.maxChars;
		if (merged.length <= opts.targetChars || rescue) {
			cur = merged;
			continue;
		}
		chunks.push(cur);
		cur = begin(unit);
	}
	if (cur.length > 0) chunks.push(cur);

	return chunks;
}

/**
 * Chunk a markdown note. Deterministic: the same string always yields the same
 * chunks with the same keys, on every platform, in every locale, forever.
 */
export function chunkNote(markdown, options) {
	const opts = normalizeOptions(options);
	const prepared = prepare(markdown);

	const raw = [];
	for (const section of splitSections(prepared)) {
		for (const text of packSection(section.text, opts)) {
			const trimmed = text.trim();
			if (trimmed.length > 0) raw.push({ text: trimmed, heading: section.heading });
		}
	}

	if (raw.length === 0) return [];

	// Step 5. The note's ONLY chunk survives however short it is — otherwise a 40-word
	// note would be invisible to every semantic feature in the suite.
	let kept = raw.length === 1 ? raw : raw.filter((c) => c.text.length >= opts.minChars);
	if (kept.length === 0) {
		// Every section was short. Rather than index nothing (which the letter of the rule
		// would do), keep the single longest — deterministic, and still one chunk per note.
		kept = [raw.reduce((best, c) => (c.text.length > best.text.length ? c : best), raw[0])];
	}

	return kept.map((c, ord) => ({
		key: chunkKey(c.text),
		ord,
		text: c.text,
		heading: c.heading,
	}));
}
