/**
 * What makes a note a question (DESIGN 8.2). Pure: no `obsidian` import, no I/O.
 *
 * A question is declared in frontmatter (`type: question`, `status: open|partial|answered`)
 * and its parent is accepted TWO ways, because Dataview is not a dependency and half the
 * vaults that would want this add-on write inline fields anyway:
 *
 *     ---
 *     type: question
 *     status: open
 *     parent: "[[Why did we drop CRDTs?]]"
 *     ---
 *
 *     parent:: [[Why did we drop CRDTs?]]
 *
 * Every key is configurable, because `type:`, `status:` and `parent::` are all common enough
 * to collide with a vault's own conventions (DESIGN Open Question 10.10).
 *
 * Robustness rules, each of which exists because the alternative silently eats a question:
 *  - An unknown `status` value is NOT a question with no status — it is an OPEN question
 *    whose status is a typo. Never drop the note.
 *  - `type` may be a scalar or a list (`type: [question, research]`).
 *  - Inline fields are scanned OUTSIDE fenced code blocks only, so a `parent::` inside a
 *    code sample in a note about this add-on does not create a phantom edge.
 *  - A parent is stored as its LINK TEXT, not a path. Resolving link text to a file is
 *    Obsidian's job (metadataCache.getFirstLinkpathDest) and it does not belong in here.
 */

/** The three states a question can be in. Anything else is a typo, and a typo is "open". */
export const STATUSES = Object.freeze(["open", "partial", "answered"]);

export const DEFAULT_QUESTION_KEYS = Object.freeze({
	/** Frontmatter key that declares the note's kind. */
	typeKey: "type",
	/** The value of `typeKey` that means "this is a question". */
	questionValue: "question",
	statusKey: "status",
	/** Used for BOTH the frontmatter key and the inline `key::` field. */
	parentKey: "parent",
});

export const DEFAULT_STATUS = "open";

/** ```fenced``` blocks, so an inline field inside a code sample is not a real field. */
const FENCE_RE = /^[ \t]*(?:```|~~~)/;

/** `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` -> `Target`. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Strip fenced code blocks. Returns the body with fenced regions blanked out. */
function withoutCodeFences(markdown) {
	const lines = String(markdown ?? "").split("\n");
	const out = [];
	let inFence = false;
	for (const line of lines) {
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			out.push("");
			continue;
		}
		out.push(inFence ? "" : line);
	}
	return out.join("\n");
}

/** `[[a/b/C.md|alias]]` -> `a/b/C`. A bare string is returned trimmed. */
export function linkTarget(value) {
	let text = String(value ?? "").trim();
	const wiki = /^\[\[(.+)\]\]$/.exec(text);
	if (wiki) text = wiki[1];
	// Order matters: an alias may itself contain a `#`.
	const pipe = text.indexOf("|");
	if (pipe !== -1) text = text.slice(0, pipe);
	const hash = text.indexOf("#");
	if (hash !== -1) text = text.slice(0, hash);
	text = text.trim();
	if (text.toLowerCase().endsWith(".md")) text = text.slice(0, -3);
	return text.trim();
}

/** Every `[[link]]` in a string, in order. Falls back to the whole string when there is none. */
function parentsFromValue(value) {
	const text = String(value ?? "").trim();
	if (text === "") return [];

	const links = [];
	WIKILINK_RE.lastIndex = 0;
	let match;
	while ((match = WIKILINK_RE.exec(text)) !== null) {
		const target = linkTarget(match[1]);
		if (target) links.push(target);
	}
	if (links.length > 0) return links;

	// No wikilink: a plain (or comma-separated) title. Trailing `]`/`)` come from the
	// bracketed inline-field forms — `[parent:: Foo]` and `(parent:: Foo)`.
	return text
		.split(",")
		.map((part) => linkTarget(part.replace(/[\])]+\s*$/, "")))
		.filter((part) => part !== "");
}

/** Frontmatter values may be a scalar, a list, or (a real vault) a list with a null hole. */
function frontmatterParents(value) {
	if (value === null || value === undefined) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.flatMap((entry) => parentsFromValue(entry));
}

/** `parent:: [[A]], [[B]]` — anywhere on a line, bracketed or not, outside code fences. */
export function inlineParents(markdown, parentKey = DEFAULT_QUESTION_KEYS.parentKey) {
	const key = String(parentKey ?? "").trim();
	if (key === "") return [];
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Group 1 is the character the field was opened with — "" (start of line), whitespace, or the
	// bracket of Dataview's `[parent:: X]` / `(parent:: X)` forms.
	const re = new RegExp(`(^|[\\s[(])${escaped}\\s*::\\s*([^\\n]*)`, "gim");

	const out = [];
	const body = withoutCodeFences(markdown);
	let match;
	while ((match = re.exec(body)) !== null) {
		const opener = match[1];
		let value = match[2];
		// A BRACKETED field ends at its closing bracket, not at the end of the line — `(parent:: Foo)
		// trailing` names Foo, not "Foo) trailing". Wikilinks are exempt: `[parent:: [[A]]]` closes
		// with `]]]`, and cutting at the first `]` would truncate the link itself.
		if (!value.includes("[[")) {
			if (opener === "[") value = value.split("]")[0];
			else if (opener === "(") value = value.split(")")[0];
		}
		out.push(...parentsFromValue(value));
	}
	return out;
}

/** `question`, `Question`, `[question, research]` — all mean the same thing. */
function declaresType(value, questionValue) {
	const want = String(questionValue ?? "").trim().toLowerCase();
	if (want === "") return false;
	const values = Array.isArray(value) ? value : [value];
	return values.some((entry) => String(entry ?? "").trim().toLowerCase() === want);
}

/**
 * Parse one note.
 *
 * @param {Record<string, unknown> | null | undefined} frontmatter as `metadataCache` gives it
 * @param {string} body the note's markdown, frontmatter included or not — either works
 * @param {Partial<typeof DEFAULT_QUESTION_KEYS>} [keys]
 * @returns {{ isQuestion: boolean, type: string, status: string, parents: string[] }}
 */
export function parseQuestion(frontmatter, body, keys) {
	const k = { ...DEFAULT_QUESTION_KEYS, ...(keys ?? {}) };
	const fm = frontmatter && typeof frontmatter === "object" ? frontmatter : {};

	const rawType = fm[k.typeKey];
	const isQuestion = declaresType(rawType, k.questionValue);

	const rawStatus = String(fm[k.statusKey] ?? "")
		.trim()
		.toLowerCase();
	// A typo is an OPEN question, not a non-question. Dropping the note would be silent
	// data loss dressed up as validation.
	const status = STATUSES.includes(rawStatus) ? rawStatus : DEFAULT_STATUS;

	const parents = dedupe([
		...frontmatterParents(fm[k.parentKey]),
		...inlineParents(body, k.parentKey),
	]);

	return {
		isQuestion,
		type: Array.isArray(rawType) ? String(rawType[0] ?? "") : String(rawType ?? ""),
		status,
		parents,
	};
}

/** True when `status` is one of the three real states (i.e. not a fallback). */
export function isKnownStatus(status) {
	return STATUSES.includes(
		String(status ?? "")
			.trim()
			.toLowerCase()
	);
}

function dedupe(values) {
	const seen = new Set();
	const out = [];
	for (const value of values) {
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}
