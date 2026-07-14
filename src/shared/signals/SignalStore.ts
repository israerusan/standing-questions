import { normalizePath } from "obsidian";
import type { App } from "obsidian";
import { SignalsBroker } from "./SignalsBroker";
import {
	DEFAULT_DWELL_CAP_MS,
	DEFAULT_MIN_SESSION_MS,
	DEFAULT_RETENTION_MS,
	DEFAULT_REVISION_GAP_MS,
	SIGNALS_MAX_LINES,
	foldSignals,
	isSignalEvent,
	parseSignalLog,
	pruneSignals,
	serializeEvent,
} from "./signalsAggregate.mjs";
import type { FoldOptions, SignalEvent, SignalKind, SignalsIndex } from "./signalsAggregate.mjs";

/**
 * The plugin-side Signals store (DESIGN 5). An append-only NDJSON log plus a compacted
 * JSON snapshot, both written through `app.vault.adapter`.
 *
 * WHY NOT SQLITE. There is no shippable SQLite in an Obsidian plugin: `better-sqlite3` is
 * a native module (wrong ABI on every user's Electron), and `sql.js` is 1.5 MB of WASM
 * that dies on mobile. SQLite exists ONLY inside the Python engine. Do not "improve" this
 * into a database.
 *
 * WHY THE ADAPTER. Every read and write goes through `app.vault.adapter` — no `fs`, no
 * `path`, no Node at all. That is what lets the free tiers ship with
 * `isDesktopOnly: false`. A static import of a Node builtin compiles to a top-level
 * `require()` in the CJS bundle and crashes on mobile before `onload` ever runs.
 *
 * LAYOUT (never the literal ".obsidian" — always `app.vault.configDir`):
 *
 *   <vault>/<configDir>/second-read/signals/
 *       <writerId>.ndjson          append-only event log
 *       <writerId>.snapshot.json   compacted aggregates + the watermark they consumed
 *
 * SYNC-SAFE BY CONSTRUCTION. A shard is named for the plugin instance that writes it, so a
 * device only ever appends to shards owned by plugins loaded on that device. If the user
 * syncs the config dir, shards merge as a union of lines instead of conflicting. Readers
 * merge every shard they find. At most two shards ever exist (only Note Decay and Effort
 * Index write).
 *
 * SINGLE WRITER. `record()` is a no-op unless this plugin holds the writer slot; see
 * SignalsBroker. Two plugins appending to one file is corruption.
 */

/** Under `app.vault.configDir`. */
export const SIGNALS_ROOT = "second-read";
export const SIGNALS_DIR = "second-read/signals";
/** Events buffer in memory and hit the disk at most this often. Never one append per keystroke. */
export const SIGNALS_FLUSH_MS = 10_000;
/**
 * THE COMPACTION HORIZON, and the reason it exists.
 *
 * Compaction folds events into a snapshot and then drops them from the log. Both steps are
 * only safe for an event that is FINISHED ARRIVING — every event that precedes it must already
 * be on disk, or the fold sees a partial history and the truncate makes that permanent.
 *
 * The other plugin's store buffers its events in memory for up to `flushMs` before it appends
 * them, and it lives in ANOTHER PLUGIN'S BUNDLE: the compactor cannot reach it, cannot flush
 * it, and cannot even see it. So at any instant, an event that happened up to `flushMs` ago may
 * still be nowhere on disk. Consume events up to "now" and this happens:
 *
 *   Effort Index buffers `dwell b.md`.  Note Decay records `rename b.md -> c.md`, flushes, and
 *   compacts. The rename folds against an index in which `b.md` DOES NOT EXIST YET, matches
 *   nothing, and is then truncated off disk forever. Ten seconds later the dwell lands and
 *   folds onto `b.md` — a path the user no longer has. `b.md`'s history can never reach `c.md`,
 *   and the next `compact(livePaths)` deletes it outright. The same shape RESURRECTS A DELETED
 *   NOTE (the delete folds against an index without the note; the note's `edit` lands after).
 *
 * The fix is a cutoff below which NO shard can still produce an event. An event stamped `t` is
 * appended by `t + flushMs` at the latest, so anything older than `now - 2*flushMs` is
 * guaranteed to be on disk already, and events are folded in timestamp order. A compaction
 * consumes only events at or below that horizon and RETAINS the rest of the log verbatim.
 *
 * This costs nothing: `readIndex()` still folds the whole log, so a reader always sees the
 * newest events. Only the snapshot lags.
 */
export const SIGNALS_COMPACT_LAG_MS = 2 * SIGNALS_FLUSH_MS;
/**
 * 2 — a snapshot now holds the fold of EVERY shard, plus a per-shard watermark, instead of
 * only its own shard's events. A v1 snapshot is discarded on read (the logs are still
 * authoritative). See `compact()` for why the old shape produced permanent ghost aggregates.
 *
 * The horizon did NOT need a version bump: a v2 snapshot written by a store that consumed up to
 * "now" and one written by a store that consumed up to the horizon differ only in how far their
 * watermarks reach, and a reader replays every log event above the watermark either way.
 */
export const SNAPSHOT_VERSION = 2;

export interface SignalStoreOptions {
	flushMs?: number;
	/** How far behind "now" a compaction stops consuming. Defaults to `2 * flushMs`; it must be
	 *  at least the largest `flushMs` of ANY store writing this vault. See
	 *  SIGNALS_COMPACT_LAG_MS — this is not a tuning knob, it is a correctness bound. */
	compactLagMs?: number;
	maxLines?: number;
	revisionGapMs?: number;
	minSessionMs?: number;
	dwellCapMs?: number;
	retentionMs?: number;
}

interface SignalsSnapshot {
	version: number;
	writerId: string;
	generatedAt: number;
	/**
	 * shard id -> the timestamp of the newest event OF THAT SHARD folded into `index`.
	 * Events at or below a shard's watermark are ALREADY counted — replaying them would
	 * double the sums. A shard with no entry has contributed nothing yet.
	 *
	 * The map (rather than one scalar) is what makes a snapshot a fold of ALL shards while
	 * each shard's log is still truncated independently, by whoever owns it.
	 */
	consumed: Record<string, number>;
	index: SignalsIndex;
}

/** A snapshot as the reader uses it. `generatedAt` picks the freshest one. */
interface LoadedSnapshot {
	index: SignalsIndex;
	consumed: Record<string, number>;
	generatedAt: number;
}

type ResolvedOptions = Required<SignalStoreOptions>;

const EMPTY_SNAPSHOT: LoadedSnapshot = { index: {}, consumed: {}, generatedAt: 0 };

/** 8 random hex chars. Uses the WEB crypto global (present in the renderer and on mobile);
 *  importing `node:crypto` would crash the mobile bundle at load time. */
export function newWriterId(): string {
	const bytes = new Uint8Array(4);
	const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
	if (webCrypto && typeof webCrypto.getRandomValues === "function") {
		webCrypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let id = "";
	for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
	return id;
}

export class SignalStore {
	private readonly app: App;
	private readonly pluginId: string;
	private readonly opts: ResolvedOptions;
	readonly writerId: string;

	private buffer: SignalEvent[] = [];
	/** Lines in OUR shard. The compaction trigger. */
	private lines = 0;
	private flushTimer: number | null = null;
	/** Serialises every write. Two overlapping `append()` calls on one file interleave. */
	private chain: Promise<void> = Promise.resolve();
	private initialised = false;
	private _disposed = false;

	constructor(app: App, pluginId: string, writerId: string, opts: SignalStoreOptions = {}) {
		this.app = app;
		this.pluginId = pluginId;
		this.writerId = writerId;
		const flushMs = opts.flushMs ?? SIGNALS_FLUSH_MS;
		this.opts = {
			flushMs,
			// Derived from OUR flushMs, which is the same constant every Second Read plugin
			// vendors — see SIGNALS_COMPACT_LAG_MS for why it cannot be smaller.
			compactLagMs: opts.compactLagMs ?? 2 * flushMs,
			maxLines: opts.maxLines ?? SIGNALS_MAX_LINES,
			revisionGapMs: opts.revisionGapMs ?? DEFAULT_REVISION_GAP_MS,
			minSessionMs: opts.minSessionMs ?? DEFAULT_MIN_SESSION_MS,
			dwellCapMs: opts.dwellCapMs ?? DEFAULT_DWELL_CAP_MS,
			retentionMs: opts.retentionMs ?? DEFAULT_RETENTION_MS,
		};
	}

	/** Read by SignalsBroker to decide whether a slot has gone stale. Public on purpose. */
	get disposed(): boolean {
		return this._disposed;
	}

	get dir(): string {
		return normalizePath(`${this.app.vault.configDir}/${SIGNALS_DIR}`);
	}

	get logPath(): string {
		return normalizePath(`${this.dir}/${this.writerId}.ndjson`);
	}

	get snapshotPath(): string {
		return normalizePath(`${this.dir}/${this.writerId}.snapshot.json`);
	}

	/** True when this plugin currently appends AT LEAST ONE event kind. */
	get isWriter(): boolean {
		return SignalsBroker.isWriter(this.pluginId);
	}

	/** True when this plugin currently appends events of `kind`. The slot is per kind: this
	 *  plugin can own `edit` while another owns `open`, which is the only reason Note Decay
	 *  and Effort Index can both record what they need with both installed. */
	isWriterFor(kind: SignalKind): boolean {
		return SignalsBroker.isWriterFor(this.pluginId, kind);
	}

	/** Creates the signals folder, seals a torn tail, counts the existing shard. Idempotent. */
	async init(): Promise<void> {
		if (this.initialised) return;
		const adapter = this.app.vault.adapter;
		const configDir = this.app.vault.configDir;
		// `mkdir` is not recursive on every adapter — walk the parents.
		for (const segment of [SIGNALS_ROOT, SIGNALS_DIR]) {
			const folder = normalizePath(`${configDir}/${segment}`);
			if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
		}

		const existing = await this.readIfExists(this.logPath);
		// A crash mid-append leaves a line without its terminating "\n". Left alone, the NEXT
		// append would be glued onto it and BOTH events would parse as garbage — one torn
		// event would cost us a second, good one. Seal the tail on load: the torn line stays
		// unparseable and is skipped, and everything after it lands on a clean line.
		if (existing.length > 0 && !existing.endsWith("\n")) {
			await adapter.append(this.logPath, "\n");
		}
		this.lines = countLines(existing);
		this.initialised = true;
	}

	/**
	 * Buffer one event. A NO-OP unless this plugin holds (or can claim) the writer slot —
	 * every Second Read plugin listens, exactly one appends.
	 *
	 * Never throws, never touches the disk: `flush()` does the I/O, at most every
	 * `flushMs`. An event that fails validation is dropped with a log line rather than
	 * poisoning the batch it is sitting in.
	 */
	record(event: SignalEvent): void {
		if (this._disposed) return;
		// Validate BEFORE electing: a malformed event must not claim a kind (its `k` is junk),
		// and it must not be able to poison the batch it would sit in.
		if (!isSignalEvent(event)) {
			console.error("second-read: refusing to record a malformed signal event", event);
			return;
		}
		// The slot is per KIND. Note Decay emits open/rename/delete and Effort Index emits
		// edit/dwell — a per-plugin slot silently dropped one plugin's entire event set.
		if (!SignalsBroker.claimIfVacant(this.app, this.pluginId, this, event.k)) return;
		this.buffer.push(event);
		this.scheduleFlush();
	}

	/** Write the buffer out now. Called on the debounce timer and from `onunload()`. */
	flush(): Promise<void> {
		this.cancelTimer();
		if (this.buffer.length === 0) return this.chain;
		const pending = this.buffer;
		this.buffer = [];
		this.chain = this.chain.then(() => this.appendBatch(pending)).catch((error) => {
			// A failed append loses this batch, not the log and not the plugin. Re-queueing
			// would grow without bound on a read-only vault.
			console.error("second-read: failed to append signals", error);
		});
		return this.chain;
	}

	/**
	 * Every shard, folded in ONE pass: the freshest snapshot as the prior, then each shard's
	 * un-consumed log tail on top, plus this store's own not-yet-flushed buffer so a reader
	 * inside the writer plugin sees its own most recent events.
	 *
	 * Folding all shards' events together (rather than per shard) is what makes a `rename` or
	 * `delete` recorded by ONE plugin apply to the OTHER plugin's aggregates — the two
	 * plugins own different event kinds and write different shards, so a delete is always
	 * "somebody else's event" to somebody.
	 */
	async readIndex(): Promise<SignalsIndex> {
		const { snapshot, byShard } = await this.gather();
		const events: SignalEvent[] = [];
		// The WHOLE un-consumed tail, horizon or no horizon. The horizon governs what a snapshot
		// may swallow, never what a reader may see: an event three seconds old is still the
		// truth, it is just not yet safe to fold it into a snapshot and delete it.
		for (const shardEvents of byShard.values()) events.push(...shardEvents);
		for (const event of this.buffer) events.push(event);
		return foldSignals(events, snapshot.index, this.foldOptions());
	}

	/**
	 * Fold every shard into a snapshot and truncate OUR log. Serialised through `this.chain`
	 * like every other write: it is public (the settings tab calls it to prune deleted notes),
	 * and running it beside an in-flight `flush()` would read the log, let the flush append,
	 * and then truncate the file — silently eating the events that had just landed.
	 *
	 * WHAT THE SNAPSHOT CONTAINS. Everything: the fold of every shard's events, not just our
	 * own. The previous shape (one snapshot per shard, holding only that shard's events)
	 * could not survive a cross-shard mutation — Effort Index writes `A.md` into shard E and
	 * compacts; Note Decay records `delete A.md` into shard D and compacts; D folds the delete
	 * against D's index, where `A.md` does not exist, deletes nothing, and truncates the event
	 * away. `A.md` is then a permanent ghost in E's snapshot that no later compaction can ever
	 * reap. A single complete index plus a PER-SHARD watermark fixes that: an event is
	 * consumed exactly once (by whichever snapshot folded it), every shard's log is still
	 * truncated only by its own owner, and a delete applies to the whole vault.
	 *
	 * WHAT IT MAY CONSUME. Only events at or below the HORIZON (`now - compactLagMs`). A shard
	 * that lives in another plugin's bundle buffers its events in memory for up to `flushMs`,
	 * and this code cannot flush it, so anything newer than the horizon may still have an older
	 * event queued behind it. Folding it anyway is what turned a cross-shard rename into
	 * permanent data loss. Everything above the horizon is written back to the log verbatim.
	 * See SIGNALS_COMPACT_LAG_MS.
	 *
	 * ORDER MATTERS: snapshot FIRST, truncate SECOND. A crash between the two leaves both the
	 * snapshot and the full log on disk — which would double-count every event, except that
	 * the snapshot records the newest event it consumed FROM EACH SHARD and the reader skips
	 * log events at or below their shard's watermark. So a crash at any point in this sequence
	 * costs nothing: worst case the log is replayed and the watermark discards it.
	 *
	 * `livePaths` (from `vault.getMarkdownFiles()`) drops aggregates for notes that no longer
	 * exist. Omit it and nothing is pruned by path — never guess a note is gone.
	 */
	compact(livePaths?: Set<string> | null, now: number = Date.now()): Promise<void> {
		this.chain = this.chain
			.then(() => this.doCompact(livePaths ?? null, now))
			.catch((error) => {
				// A failed compaction leaves the log intact — it is only ever truncated after
				// the snapshot has landed. Nothing is lost; the next one tries again.
				console.error("second-read: failed to compact signals", error);
			});
		return this.chain;
	}

	/** The "Clear activity log" button. Erases every shard, not just ours — the user asked
	 *  to erase their activity, not to erase half of it. */
	async clear(): Promise<void> {
		this.cancelTimer();
		this.buffer = [];
		this.chain = this.chain.then(async () => {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.dir))) return;
			const listing = await adapter.list(this.dir);
			for (const file of listing.files) {
				if (file.endsWith(".ndjson") || file.endsWith(".snapshot.json")) await adapter.remove(file);
			}
			this.lines = 0;
		});
		return this.chain;
	}

	/** Stops the debounce timer and marks the store dead. The broker reads `disposed` to
	 *  decide the writer slot has gone stale. Call `flush()` BEFORE this, from `onunload()`. */
	dispose(): void {
		this.cancelTimer();
		this._disposed = true;
	}

	// ---------------------------------------------------------------- internals

	private foldOptions(): FoldOptions {
		return {
			revisionGapMs: this.opts.revisionGapMs,
			minSessionMs: this.opts.minSessionMs,
			dwellCapMs: this.opts.dwellCapMs,
		};
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null || this._disposed) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, this.opts.flushMs);
	}

	private cancelTimer(): void {
		if (this.flushTimer === null) return;
		window.clearTimeout(this.flushTimer);
		this.flushTimer = null;
	}

	private async appendBatch(events: SignalEvent[]): Promise<void> {
		await this.init();
		await this.appendLines(events);
		// Already ON the chain — call doCompact directly. Going through the public compact()
		// would enqueue behind the promise we are currently inside and deadlock.
		if (this.lines >= this.opts.maxLines) await this.doCompact(null, Date.now());
	}

	private async appendLines(events: SignalEvent[]): Promise<void> {
		if (events.length === 0) return;
		const payload = events.map(serializeEvent).join("");
		// One `append` per batch. The adapter creates the file if it is missing.
		await this.app.vault.adapter.append(this.logPath, payload);
		this.lines += events.length;
	}

	/**
	 * The freshest snapshot, plus each shard's log events that it has NOT already consumed,
	 * KEYED BY SHARD. The caller decides what to do with them: `readIndex()` folds all of them,
	 * `doCompact()` folds only the ones below the horizon and puts ours back on disk.
	 */
	private async gather(): Promise<{ snapshot: LoadedSnapshot; byShard: Map<string, SignalEvent[]> }> {
		const shards = await this.listShards();

		let snapshot = EMPTY_SNAPSHOT;
		for (const shard of shards) {
			const candidate = await this.readSnapshot(normalizePath(`${this.dir}/${shard}.snapshot.json`));
			// The freshest snapshot is the fold of EVERY shard, so exactly one of them is the
			// prior. Merging them all would double-count every event they both consumed.
			if (candidate.generatedAt >= snapshot.generatedAt) snapshot = candidate;
		}

		const byShard = new Map<string, SignalEvent[]>();
		for (const shard of shards) {
			const parsed = parseSignalLog(await this.readIfExists(normalizePath(`${this.dir}/${shard}.ndjson`)));
			const watermark = snapshot.consumed[shard] ?? 0;
			byShard.set(
				shard,
				parsed.events.filter((event) => event.t > watermark)
			);
		}
		return { snapshot, byShard };
	}

	private async doCompact(livePaths: Set<string> | null, now: number): Promise<void> {
		await this.init();
		const adapter = this.app.vault.adapter;

		// Land the buffer before we fold. Otherwise a buffered event would be appended AFTER
		// the watermark that already covers its timestamp, and the reader would skip it. This
		// only reaches OUR buffer — the other plugin's store is in another bundle, which is the
		// whole reason the horizon below has to exist.
		const pending = this.buffer;
		this.buffer = [];
		await this.appendLines(pending);

		const { snapshot, byShard } = await this.gather();

		// THE HORIZON. Nothing newer than this may be folded or truncated — another shard could
		// still be holding an event that BELONGS BEFORE IT. See SIGNALS_COMPACT_LAG_MS.
		const horizon = now - this.opts.compactLagMs;

		const consumable: SignalEvent[] = [];
		/** Our own log lines above the horizon. They go straight back onto disk. */
		const retained: SignalEvent[] = [];
		/** Paths an un-consumed event still refers to, from ANY shard. */
		const unsettled = new Set<string>();
		const consumed: Record<string, number> = { ...snapshot.consumed };

		for (const [shard, shardEvents] of byShard) {
			let watermark = snapshot.consumed[shard] ?? 0;
			for (const event of shardEvents) {
				if (event.t <= horizon) {
					consumable.push(event);
					if (event.t > watermark) watermark = event.t;
					continue;
				}
				// Above the horizon: it stays on disk and its shard's watermark stays below it, so
				// the next compaction that can see the whole picture folds it then. Its owner
				// rewrites its own log; we only rewrite ours.
				if (shard === this.writerId) retained.push(event);
				unsettled.add(event.p);
				if (event.k === "rename") unsettled.add(event.from);
			}
			consumed[shard] = watermark;
		}

		let index = foldSignals(consumable, snapshot.index, this.foldOptions());
		// A path that an un-consumed event still names is NOT prunable, even though the vault no
		// longer has a file there: the `rename` that will carry its history to the new path has
		// not been folded yet, and pruning by `livePaths` would delete the source out from under
		// it — losing exactly the history the rename exists to preserve.
		index = pruneSignals(index, keepAlso(livePaths, unsettled), now, this.opts.retentionMs);

		const payload: SignalsSnapshot = {
			version: SNAPSHOT_VERSION,
			writerId: this.writerId,
			generatedAt: now,
			consumed,
			index,
		};
		await adapter.write(this.snapshotPath, JSON.stringify(payload));
		// Only OUR shard, and only the part of it the snapshot above actually CONSUMED. Blanking
		// the file threw away every event still above the horizon — including, in the worst case,
		// the only copy of a cross-shard rename or delete. Another plugin owns its own log file
		// and truncates it itself, on its own next compaction, against its own watermark.
		await adapter.write(this.logPath, retained.map(serializeEvent).join(""));
		this.lines = retained.length;
	}

	private async readIfExists(path: string): Promise<string> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) return "";
		try {
			return await adapter.read(path);
		} catch (error) {
			console.error(`second-read: could not read ${path}`, error);
			return "";
		}
	}

	/** A corrupt snapshot must degrade to "no snapshot" (the log is still authoritative),
	 *  never to a crash on load. A snapshot from an older SNAPSHOT_VERSION is discarded the
	 *  same way — its watermark means something different and replaying the log is safe. */
	private async readSnapshot(path: string): Promise<LoadedSnapshot> {
		const text = await this.readIfExists(path);
		if (text.trim() === "") return EMPTY_SNAPSHOT;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			console.error(`second-read: discarding a corrupt signals snapshot at ${path}`);
			return EMPTY_SNAPSHOT;
		}
		if (!parsed || typeof parsed !== "object") return EMPTY_SNAPSHOT;
		const snapshot = parsed as Partial<SignalsSnapshot>;
		if (snapshot.version !== SNAPSHOT_VERSION) return EMPTY_SNAPSHOT;
		if (!snapshot.index || typeof snapshot.index !== "object") return EMPTY_SNAPSHOT;

		const consumed: Record<string, number> = Object.create(null);
		if (snapshot.consumed && typeof snapshot.consumed === "object") {
			for (const [shard, value] of Object.entries(snapshot.consumed)) {
				if (typeof value === "number" && Number.isFinite(value)) consumed[shard] = value;
			}
		}
		const generatedAt =
			typeof snapshot.generatedAt === "number" && Number.isFinite(snapshot.generatedAt)
				? snapshot.generatedAt
				: 0;
		return { index: snapshot.index, consumed, generatedAt };
	}

	/** Distinct writer ids with a file in the signals folder. */
	private async listShards(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.dir))) return [];
		const listing = await adapter.list(this.dir);
		const shards = new Set<string>();
		for (const file of listing.files) {
			const name = file.slice(file.lastIndexOf("/") + 1);
			if (name.endsWith(".snapshot.json")) shards.add(name.slice(0, -".snapshot.json".length));
			else if (name.endsWith(".ndjson")) shards.add(name.slice(0, -".ndjson".length));
		}
		return [...shards].sort();
	}
}

/** `livePaths`, widened by the paths a not-yet-folded event still depends on. `null` in (keep
 *  everything) stays `null` out — a caller that cannot enumerate the vault prunes nothing. */
function keepAlso(livePaths: Set<string> | null, extra: Set<string>): Set<string> | null {
	if (!livePaths || extra.size === 0) return livePaths;
	const union = new Set(livePaths);
	for (const path of extra) union.add(path);
	return union;
}

function countLines(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim() !== "") count += 1;
	}
	return count;
}
