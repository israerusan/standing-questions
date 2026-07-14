/**
 * The Signals aggregate — PURE. No `obsidian` import, no Node builtin, no I/O, no clock.
 *
 * This is the whole reason the shared store can be trusted: every rule that decides how
 * many milliseconds of "real work" a note absorbed lives here, in one file, testable
 * with plain asserts, vendored byte-identically into every plugin that reads or writes
 * the log. Note Decay and Effort Index MUST agree on these numbers or the same vault
 * shows two different truths.
 *
 * The log itself is append-only NDJSON (DESIGN 5.3). There is no SQLite anywhere near a
 * plugin: better-sqlite3 is a native module and sql.js is 1.5 MB of WASM that dies on
 * mobile. SQLite exists only inside the Python engine. So: one object per line, one line
 * per event, `\n`-terminated, folded back into aggregates here.
 *
 * Robustness contract (a crash mid-append MUST NOT poison the log):
 *   - `parseSignalLog` never throws. A truncated final line, a half-written line that a
 *     later append concatenated onto, or a line of valid JSON with the wrong shape is
 *     COUNTED and SKIPPED. Losing one event is acceptable; losing the file is not.
 *   - `foldSignals` re-validates every event it is handed, so a caller that bypasses the
 *     parser cannot poison the aggregates either.
 */

/** Revision = a burst separated from the previous burst by at least this gap. */
export const DEFAULT_REVISION_GAP_MS = 1_800_000;
/** Bursts shorter than this are noise (a stray keystroke in a note you opened by mistake). */
export const DEFAULT_MIN_SESSION_MS = 5_000;
/** A single dwell event can never contribute more than this (you walked away). */
export const DEFAULT_DWELL_CAP_MS = 1_800_000;
/** Silence after which an editing burst is closed by the emitter. Documented here because
 *  it is WHY an `edit` event's `ms` is "last keystroke − session start" and not "now −
 *  session start": the idle tail is not work, and it is never counted. See `foldSignals`. */
export const DEFAULT_IDLE_CUTOFF_MS = 60_000;
/** Two years. Older aggregates are dropped at compaction. */
export const DEFAULT_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;
/** A shard is compacted (fold → snapshot → truncate) once it exceeds this many lines. */
export const SIGNALS_MAX_LINES = 20_000;

/** The closed set of event kinds. Anything else is malformed. */
export const EVENT_KINDS = ["open", "edit", "dwell", "rename", "delete"];

/** A zeroed aggregate. Null-prototype so a note literally named `__proto__.md` cannot
 *  reach through the index and rewrite Object.prototype. */
export function emptyNoteSignals(firstSeen = 0) {
	const signals = Object.create(null);
	signals.firstSeen = firstSeen;
	signals.lastOpen = 0;
	signals.opens = 0;
	signals.editMs = 0;
	signals.editSessions = 0;
	signals.revisions = 0;
	signals.lastEdit = 0;
	signals.dwellMs = 0;
	return signals;
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

/** True when `value` is a well-formed event for its kind. The ONLY gate on the log. */
export function isSignalEvent(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!isFiniteNumber(value.t) || value.t <= 0) return false;
	if (!isNonEmptyString(value.p)) return false;
	switch (value.k) {
		case "open":
		case "delete":
			return true;
		case "edit":
		case "dwell":
			return isFiniteNumber(value.ms) && value.ms >= 0;
		case "rename":
			return isNonEmptyString(value.from);
		default:
			return false;
	}
}

/**
 * Parse an NDJSON shard. NEVER throws — that is the point.
 *
 * @returns {{ events: object[], malformed: number }} `malformed` counts lines that were
 * dropped: a truncated tail (the process died between the write and the newline), a line
 * that a subsequent append glued onto a truncated one, or a shape we do not recognise.
 */
export function parseSignalLog(text) {
	const events = [];
	let malformed = 0;
	if (typeof text !== "string" || text.length === 0) return { events, malformed };
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			malformed += 1;
			continue;
		}
		if (!isSignalEvent(value)) {
			malformed += 1;
			continue;
		}
		events.push(value);
	}
	return { events, malformed };
}

/**
 * One event → one `\n`-terminated line, with a stable key order. Throws on a malformed
 * event: the writer validates before buffering, so reaching this with garbage is a bug in
 * the caller, not a condition to swallow.
 */
export function serializeEvent(event) {
	if (!isSignalEvent(event)) {
		throw new TypeError(`refusing to append a malformed signal event: ${JSON.stringify(event)}`);
	}
	const line = { t: event.t, k: event.k, p: event.p };
	if (event.k === "edit") {
		line.ms = event.ms;
		if (isFiniteNumber(event.keys)) line.keys = event.keys;
	} else if (event.k === "dwell") {
		line.ms = event.ms;
	} else if (event.k === "rename") {
		line.from = event.from;
	}
	return `${JSON.stringify(line)}\n`;
}

function coerce(value, fallback) {
	return isFiniteNumber(value) && value >= 0 ? value : fallback;
}

function copySignals(source) {
	const signals = emptyNoteSignals(coerce(source?.firstSeen, 0));
	signals.lastOpen = coerce(source?.lastOpen, 0);
	signals.opens = coerce(source?.opens, 0);
	signals.editMs = coerce(source?.editMs, 0);
	signals.editSessions = coerce(source?.editSessions, 0);
	signals.revisions = coerce(source?.revisions, 0);
	signals.lastEdit = coerce(source?.lastEdit, 0);
	signals.dwellMs = coerce(source?.dwellMs, 0);
	return signals;
}

function cloneIndex(source) {
	const index = Object.create(null);
	if (!source || typeof source !== "object") return index;
	for (const [path, signals] of Object.entries(source)) {
		if (!signals || typeof signals !== "object") continue;
		index[path] = copySignals(signals);
	}
	return index;
}

function minSeen(a, b) {
	if (a > 0 && b > 0) return Math.min(a, b);
	return a > 0 ? a : b;
}

function mergePair(a, b) {
	const signals = emptyNoteSignals(minSeen(a.firstSeen, b.firstSeen));
	signals.lastOpen = Math.max(a.lastOpen, b.lastOpen);
	signals.opens = a.opens + b.opens;
	signals.editMs = a.editMs + b.editMs;
	signals.editSessions = a.editSessions + b.editSessions;
	signals.revisions = a.revisions + b.revisions;
	signals.lastEdit = Math.max(a.lastEdit, b.lastEdit);
	signals.dwellMs = a.dwellMs + b.dwellMs;
	return signals;
}

function touch(index, path, t) {
	const existing = index[path];
	if (existing) {
		existing.firstSeen = minSeen(existing.firstSeen, t);
		return existing;
	}
	const created = emptyNoteSignals(t);
	index[path] = created;
	return created;
}

/**
 * Fold a raw event stream (any order, any number of shards, any amount of junk) into
 * per-note aggregates, optionally on top of a `prior` snapshot.
 *
 * THE IDLE BOUNDARY. An `edit` event's `ms` is the ACTIVE span of a burst — last
 * keystroke minus session start — because a burst closes only after `IDLE_CUTOFF_MS` of
 * silence, and that trailing silence is not work (DESIGN 5.3). The emitter is responsible
 * for trimming it, but the fold does not trust the emitter: a burst's active span cannot
 * possibly exceed the wall clock since the previous burst on that note closed, so `ms` is
 * clamped to that window. An old build, a corrupted line, or a clock jump that claims
 * "9 hours of editing since the burst that ended 60 seconds ago" contributes 60 seconds,
 * not 9 hours. Editing time can therefore never accrue across an idle gap.
 *
 * Bursts shorter than `minSessionMs` are discarded outright (same rule, same reason).
 */
export function foldSignals(events, prior, opts = {}) {
	const revisionGapMs = coerce(opts.revisionGapMs, DEFAULT_REVISION_GAP_MS);
	const minSessionMs = coerce(opts.minSessionMs, DEFAULT_MIN_SESSION_MS);
	const dwellCapMs = coerce(opts.dwellCapMs, DEFAULT_DWELL_CAP_MS);

	const index = cloneIndex(prior);
	const ordered = (Array.isArray(events) ? events : [])
		.filter(isSignalEvent)
		.slice()
		.sort((a, b) => a.t - b.t);

	for (const event of ordered) {
		if (event.k === "delete") {
			// The note is gone. Its aggregate goes with it — an aggregate for a path that
			// no longer exists is a ghost row in every view that reads this store.
			delete index[event.p];
			continue;
		}

		if (event.k === "rename") {
			const source = index[event.from];
			if (!source) continue;
			delete index[event.from];
			const target = index[event.p];
			index[event.p] = target ? mergePair(target, source) : source;
			continue;
		}

		const signals = touch(index, event.p, event.t);

		if (event.k === "open") {
			signals.opens += 1;
			if (event.t > signals.lastOpen) signals.lastOpen = event.t;
			continue;
		}

		if (event.k === "edit") {
			const ms = Math.max(0, Math.floor(event.ms));
			if (ms < minSessionMs) continue;
			const anchor = signals.lastEdit > 0 ? signals.lastEdit : signals.firstSeen;
			const window = anchor > 0 && event.t > anchor ? event.t - anchor : Infinity;
			const gap = signals.lastEdit > 0 ? event.t - signals.lastEdit : Infinity;
			signals.editMs += Math.min(ms, window);
			signals.editSessions += 1;
			if (gap >= revisionGapMs) signals.revisions += 1;
			if (event.t > signals.lastEdit) signals.lastEdit = event.t;
			continue;
		}

		if (event.k === "dwell") {
			const ms = Math.max(0, Math.floor(event.ms));
			signals.dwellMs += Math.min(ms, dwellCapMs);
		}
	}

	return index;
}

/**
 * Merge N shard snapshots. Sums are additive — shards are disjoint in time, because only
 * one plugin ever holds the writer slot (DESIGN 5.2), so no event is in two shards.
 * `lastOpen`/`lastEdit` take the max; `firstSeen` takes the min of the non-zero values.
 */
export function mergeSignals(indexes) {
	const out = Object.create(null);
	for (const index of Array.isArray(indexes) ? indexes : []) {
		if (!index || typeof index !== "object") continue;
		for (const [path, signals] of Object.entries(index)) {
			if (!signals || typeof signals !== "object") continue;
			const incoming = copySignals(signals);
			out[path] = out[path] ? mergePair(out[path], incoming) : incoming;
		}
	}
	return out;
}

/** The most recent moment we observed anything at all about a note. */
export function lastActivity(signals) {
	if (!signals || typeof signals !== "object") return 0;
	return Math.max(coerce(signals.firstSeen, 0), coerce(signals.lastOpen, 0), coerce(signals.lastEdit, 0));
}

/**
 * Drop notes that no longer exist in the vault and notes untouched for longer than the
 * retention window. Used by compaction — this is the only thing that keeps the store from
 * growing forever. `livePaths` of `null`/`undefined` means "keep every path" (a caller
 * that cannot enumerate the vault must not silently erase the user's history).
 */
export function pruneSignals(index, livePaths, now, retentionMs = DEFAULT_RETENTION_MS) {
	const cutoff = now - coerce(retentionMs, DEFAULT_RETENTION_MS);
	const out = Object.create(null);
	for (const [path, signals] of Object.entries(index || {})) {
		if (!signals || typeof signals !== "object") continue;
		if (livePaths && !livePaths.has(path)) continue;
		if (lastActivity(signals) < cutoff) continue;
		out[path] = copySignals(signals);
	}
	return out;
}
