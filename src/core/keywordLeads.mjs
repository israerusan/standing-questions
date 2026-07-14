/**
 * The FREE lead matcher (DESIGN 8.2). Pure, synchronous, no engine, no Node — which is what
 * makes the free tier real on a phone.
 *
 * Two signals, either of which is enough:
 *
 *  1. SIGNIFICANT TOKEN OVERLAP between the new note's title/headings and the question's
 *     title/body. Stopwords are dropped, words are stemmed by suffix-strip, and the bar is
 *     two shared tokens — one is a coincidence ("notes"), two is a topic.
 *  2. A SHARED LINK. The new note links to a note the question already links to. This is the
 *     signal keyword matching cannot see and semantic search does not either: the vault's own
 *     structure saying these two notes are about the same thing, in different words.
 *
 * It is deliberately worse than the Pro semantic matcher, and deliberately not useless: a
 * note titled "CRDT merge benchmarks" WILL find "Why did we drop the CRDT plan?" here, for
 * nothing, on any device. What it cannot do is find "Why did we drop the CRDT plan?" from a
 * note titled "Storage rewrite, week 3" that never says CRDT — which is the whole reason the
 * semantic engine exists.
 */

/** Words that carry no topic. Kept small: an over-long list starts eating real terms. */
export const STOPWORDS = Object.freeze(
	new Set([
		"a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "because",
		"been", "before", "being", "between", "both", "but", "by", "can", "could", "did", "do", "does",
		"doing", "done", "down", "during", "each", "few", "for", "from", "further", "had", "has",
		"have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", "into",
		"is", "it", "its", "just", "me", "more", "most", "my", "no", "nor", "not", "now", "of", "off",
		"on", "once", "one", "only", "or", "other", "our", "ours", "out", "over", "own", "same",
		"she", "should", "so", "some", "still", "such", "than", "that", "the", "their", "theirs",
		"them", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
		"until", "up", "use", "used", "using", "very", "was", "we", "were", "what", "when", "where",
		"which", "while", "who", "whom", "why", "will", "with", "would", "you", "your", "yours",
		// Vault-generic words that would otherwise join every note to every question.
		"note", "notes", "question", "questions", "idea", "ideas", "thing", "things", "todo",
	])
);

/** Shorter than this and a token is noise, not a topic. */
export const MIN_TOKEN_CHARS = 3;

/** Suffix-strip stemming. Not Porter — deliberately: it must be obvious why two words matched. */
export function stem(word) {
	let text = String(word ?? "").toLowerCase();
	if (text.length <= 4) return text;
	if (text.endsWith("ies") && text.length > 4) return text.slice(0, -3) + "y";
	if (text.endsWith("sses")) return text.slice(0, -2);
	if (text.endsWith("ing") && text.length > 5) return text.slice(0, -3);
	if (text.endsWith("ed") && text.length > 4) return text.slice(0, -2);
	if (text.endsWith("es") && text.length > 4) return text.slice(0, -2);
	if (text.endsWith("s") && !text.endsWith("ss")) return text.slice(0, -1);
	return text;
}

/** Lowercase word tokens, stopword-filtered, stemmed, de-duplicated, in order. */
export function significantTokens(text) {
	const words = String(text ?? "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

	const out = [];
	const seen = new Set();
	for (const word of words) {
		if (word.length < MIN_TOKEN_CHARS) continue;
		if (STOPWORDS.has(word)) continue;
		const stemmed = stem(word);
		if (stemmed.length < MIN_TOKEN_CHARS) continue;
		if (STOPWORDS.has(stemmed) || seen.has(stemmed)) continue;
		seen.add(stemmed);
		out.push(stemmed);
	}
	return out;
}

/** `Projects/Storage benchmarks.md` -> `Storage benchmarks`. */
export function basename(path) {
	const text = String(path ?? "");
	const slash = text.lastIndexOf("/");
	const name = slash === -1 ? text : text.slice(slash + 1);
	return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Leads for one changed note, against the open questions.
 *
 * @param {{path: string, title?: string, headings?: string[], links?: string[]}} note the note just edited
 * @param {Array<{path: string, title?: string, status?: string, text?: string, links?: string[]}>} questions
 * @param {{minSharedTokens?: number, maxLeads?: number}} [options]
 * @returns {Array<{question: string, questionTitle: string, link: string, reason: string, shared: string[], sharedLinks: string[]}>}
 */
export function keywordLeads(note, questions, options) {
	const opts = { minSharedTokens: 2, maxLeads: 3, ...(options ?? {}) };
	const sourcePath = String(note?.path ?? "");
	if (sourcePath === "") return [];

	const noteTokens = new Set(
		significantTokens([note?.title ?? basename(sourcePath), ...(note?.headings ?? [])].join(" "))
	);
	const noteLinks = new Set((note?.links ?? []).map((link) => String(link)));

	const leads = [];
	for (const question of Array.isArray(questions) ? questions : []) {
		const qPath = String(question?.path ?? "");
		if (qPath === "" || qPath === sourcePath) continue; // A question never answers itself.
		if (String(question?.status ?? "open").toLowerCase() === "answered") continue;

		const qTokens = significantTokens(
			[question?.title ?? basename(qPath), question?.text ?? ""].join(" ")
		);
		const shared = qTokens.filter((token) => noteTokens.has(token));
		const sharedLinks = (question?.links ?? [])
			.map((link) => String(link))
			.filter((link) => link !== sourcePath && link !== qPath && noteLinks.has(link));

		if (shared.length < opts.minSharedTokens && sharedLinks.length === 0) continue;

		leads.push({
			question: qPath,
			questionTitle: question?.title ?? basename(qPath),
			link: basename(sourcePath),
			reason: describe(shared, sharedLinks),
			shared,
			sharedLinks,
		});
	}

	// Rank by the strength of the evidence: a shared link outranks a shared word, and more of
	// either outranks less. Ties break on the path, so the ordering is stable across runs.
	leads.sort(
		(a, b) =>
			b.sharedLinks.length - a.sharedLinks.length ||
			b.shared.length - a.shared.length ||
			(a.question < b.question ? -1 : 1)
	);
	return leads.slice(0, Math.max(0, opts.maxLeads));
}

function describe(shared, sharedLinks) {
	const parts = [];
	if (shared.length > 0) parts.push(`shares ${shared.slice(0, 3).join(", ")}`);
	if (sharedLinks.length > 0) {
		parts.push(`both link ${sharedLinks.slice(0, 2).map((link) => basename(link)).join(", ")}`);
	}
	return parts.join("; ");
}
