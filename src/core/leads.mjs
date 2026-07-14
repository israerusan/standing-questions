/**
 * Leads: the "this new note may answer a question you asked in January" machinery, minus
 * the vault and minus the engine. Pure — no `obsidian`, no I/O.
 *
 * Two halves, and they are separate on purpose:
 *
 *  - selectLeads() is the THRESHOLD GATE. It decides what the user is told about, and it is
 *    the difference between magic and alert fatigue. It is a pure function of the hits and
 *    the settings so it can be tested, and so the numbers are auditable rather than folklore
 *    scattered through the pipeline.
 *
 *  - appendLead() writes a lead into a question note's `## Leads` section, IDEMPOTENTLY. It
 *    is a string transform, which is what makes it safe to hand to `Vault.process` — the
 *    whole note goes in, the whole note comes out, and everything the add-on did not put
 *    there is byte-identical.
 */

export const LEADS_HEADING_TEXT = "Leads";
export const LEADS_HEADING = `## ${LEADS_HEADING_TEXT}`;

/** Any ATX heading — where the Leads section stops. */
const HEADING_RE = /^#{1,6}\s/;
const LEADS_HEADING_RE = /^#{1,6}\s+leads\s*$/i;

/** How much of the matching passage a lead quotes. Long enough to judge, short enough to skim. */
export const PREVIEW_MAX_CHARS = 110;

/**
 * The shipped thresholds. `settings.ts` seeds DEFAULT_SETTINGS from these, so the numbers
 * exist exactly once and a test can assert on them without importing TypeScript.
 *
 * `leadMinScore` is 0.75, and DESIGN 6.5 tabulates 0.60. The difference is deliberate and it
 * is the whole product: on MiniLM, 0.40–0.60 is where merely RELATED English text lives, so a
 * 0.60 bar interrupts the user about notes that share a subject area rather than an answer.
 * 0.75 is the bottom of the near-duplicate band — when it fires, the note really is about that
 * question. It is a slider, and a user who wants the firehose can have it.
 */
export const DEFAULT_LEAD_OPTIONS = Object.freeze({
	leadMinScore: 0.75,
	/** OFF. Notify-only: nothing is written into a note unless the user clicks. */
	leadAutoAppend: false,
	leadAutoAppendScore: 0.85,
	maxLeads: 3,
});

/**
 * The hits worth telling the user about, and the ones (if they opted in) worth writing down
 * without asking.
 *
 * DEFAULTS ARE CONSERVATIVE AND NOTIFY-ONLY. A false positive here does not cost a wrong
 * answer, it costs trust: an add-on that interrupts you about a note that has nothing to do
 * with your question gets muted within a day, and a muted add-on has no features. So the
 * bar is set where a hit is nearly always a real one, and the user is free to lower it.
 *
 * @param {Array<{question: string, score?: number, preview?: string, reason?: string}>} hits
 * @param {{leadMinScore?: number, leadAutoAppend?: boolean, leadAutoAppendScore?: number, maxLeads?: number, excludeQuestions?: Iterable<string>}} [options]
 * @returns {{ notify: object[], autoAppend: object[] }}
 */
export function selectLeads(hits, options) {
	const opts = { ...DEFAULT_LEAD_OPTIONS, ...(options ?? {}) };
	const excluded = new Set(opts.excludeQuestions ?? []);

	/** One lead per question: a note that hits three chunks of the same question is one lead. */
	const best = new Map();
	for (const hit of Array.isArray(hits) ? hits : []) {
		if (!hit || typeof hit.question !== "string" || hit.question === "") continue;
		if (excluded.has(hit.question)) continue;
		const score = typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : null;
		// A keyword lead carries no score. It has already passed its own (integer) threshold in
		// keywordLeads.mjs, so it is not re-filtered here — but it can never be auto-appended,
		// because "two words in common" is not evidence worth writing into a note unasked.
		if (score !== null && score < opts.leadMinScore) continue;
		const prior = best.get(hit.question);
		if (!prior || (score ?? -1) > (prior.score ?? -1)) best.set(hit.question, { ...hit, score });
	}

	const ranked = [...best.values()]
		.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.question < b.question ? -1 : 1))
		.slice(0, Math.max(0, opts.maxLeads));

	const notify = [];
	const autoAppend = [];
	for (const lead of ranked) {
		const auto =
			opts.leadAutoAppend === true &&
			typeof lead.score === "number" &&
			lead.score >= opts.leadAutoAppendScore;
		// DESIGN 8.2: auto-append REPLACES the notice for that lead — being told about a thing
		// that has already been done is just noise.
		if (auto) autoAppend.push(lead);
		else notify.push(lead);
	}
	return { notify, autoAppend };
}

/** `- [[Storage benchmarks]] — 0.81 · "…the merge cost scaled with…"` */
export function formatLead(lead) {
	const link = String(lead?.link ?? "").trim();
	const parts = [`- [[${link}]]`];
	const score = typeof lead?.score === "number" && Number.isFinite(lead.score) ? lead.score : null;
	const reason = String(lead?.reason ?? "").trim();

	if (score !== null) parts.push(`— ${score.toFixed(2)}`);
	else if (reason) parts.push(`— ${reason}`);

	const preview = cleanPreview(lead?.preview);
	if (preview) parts.push(`${score !== null || reason ? "·" : "—"} "${preview}"`);

	return parts.join(" ");
}

/** True when `## Leads` already links `link`. The idempotency check. */
export function hasLead(markdown, link) {
	const target = String(link ?? "").trim();
	if (target === "") return false;
	const { start, end } = leadsSection(String(markdown ?? "").split("\n"));
	if (start === -1) return false;
	const lines = String(markdown ?? "").split("\n").slice(start, end);
	return lines.some((line) => linksTo(line, target));
}

/**
 * Append a lead under `## Leads`, creating the section when it is absent.
 *
 * Idempotent: a lead whose link is already in the section is a no-op, returned byte-for-byte.
 * The add-on runs on every modify of every note; without this, a note that keeps getting
 * edited would accrete the same lead line for ever.
 *
 * Content AFTER the Leads section is preserved — the section is not "the rest of the file".
 *
 * @param {string} markdown the whole note
 * @param {{link: string, score?: number, preview?: string, reason?: string}} lead
 * @returns {string} the whole note
 */
export function appendLead(markdown, lead) {
	const text = String(markdown ?? "");
	const link = String(lead?.link ?? "").trim();
	if (link === "") return text;
	if (hasLead(text, link)) return text;

	const line = formatLead(lead);
	const lines = text.split("\n");
	const { start, end } = leadsSection(lines);

	if (start === -1) {
		// No section. Add one at the end, separated by a blank line, and keep the file's
		// trailing newline if it had one.
		const trailingNewline = text.endsWith("\n");
		const body = trailingNewline ? text.slice(0, -1) : text;
		const separator = body.trim() === "" ? "" : "\n\n";
		return `${body}${separator}${LEADS_HEADING}\n\n${line}\n`;
	}

	// Insert after the last non-blank line of the section, so a blank line that separates the
	// section from the next heading stays where the user put it.
	let insertAt = end;
	while (insertAt > start && lines[insertAt - 1].trim() === "") insertAt--;
	lines.splice(insertAt, 0, line);
	return lines.join("\n");
}

/** [start, end) line indices of the Leads section BODY (heading excluded). start === -1 when absent. */
function leadsSection(lines) {
	const heading = lines.findIndex((line) => LEADS_HEADING_RE.test(line));
	if (heading === -1) return { start: -1, end: -1 };

	let end = heading + 1;
	while (end < lines.length && !HEADING_RE.test(lines[end])) end++;
	return { start: heading + 1, end };
}

/** `[[Target]]` / `[[Target|alias]]` / `[[Target#heading]]`, case-insensitively. */
function linksTo(line, target) {
	const re = /\[\[([^\]]+)\]\]/g;
	const want = target.toLowerCase();
	let match;
	while ((match = re.exec(line)) !== null) {
		const text = match[1].split("|")[0].split("#")[0].trim().toLowerCase();
		if (text === want) return true;
		// `[[Folder/Note]]` in the note vs `Note` as the lead link, and vice versa.
		if (text.endsWith(`/${want}`) || want.endsWith(`/${text}`)) return true;
	}
	return false;
}

function cleanPreview(value) {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/["“”]/g, "")
		.trim();
	if (text === "") return "";
	if (text.length <= PREVIEW_MAX_CHARS) return text;
	return text.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
}
