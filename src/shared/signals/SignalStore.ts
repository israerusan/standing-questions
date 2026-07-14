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
	mergeSignals,
	parseSignalLog,
	pruneSignals,
	serializeEvent,
} from "./signalsAggregate.mjs";
import type { FoldOptions, SignalEvent, SignalsIndex } from "./signalsAggregate.mjs";

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
export const SNAPSHOT_VERSION = 1;

export interface SignalStoreOptions {
	flushMs?: number;
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
	/** The timestamp of the newest event folded into `index`. Events at or below this are
	 *  ALREADY counted — replaying them would double the sums. See `compact()`. */
	upTo: number;
	index: SignalsIndex;
}

type ResolvedOptions = Required<SignalStoreOptions>;

const EMPTY_SNAPSHOT: { index: SignalsIndex; upTo: number } = { index: {}, upTo: 0 };

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
		this.opts = {
			flushMs: opts.flushMs ?? SIGNALS_FLUSH_MS,
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

	/** True when this plugin currently owns the append. */
	get isWriter(): boolean {
		return SignalsBroker.isWriter(this.pluginId);
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
		if (!SignalsBroker.claimIfVacant(this.app, this.pluginId, this)) return;
		if (!isSignalEvent(event)) {
			console.error("second-read: refusing to record a malformed signal event", event);
			return;
		}
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
	 * Every shard, merged: snapshots first, then the un-consumed tail of each log folded on
	 * top, plus this store's own not-yet-flushed buffer so a reader inside the writer plugin
	 * sees its own most recent events.
	 *
	 * Folding ALL shards' events in one pass (rather than per shard) is what makes a
	 * `rename` or `delete` recorded by one plugin apply to the other plugin's aggregates.
	 */
	async readIndex(): Promise<SignalsIndex> {
		const priors: SignalsIndex[] = [];
		const events: SignalEvent[] = [];

		for (const shard of await this.listShards()) {
			const snapshot = await this.readSnapshot(normalizePath(`${this.dir}/${shard}.snapshot.json`));
			priors.push(snapshot.index);
			const parsed = parseSignalLog(await this.readIfExists(normalizePath(`${this.dir}/${shard}.ndjson`)));
			for (const event of parsed.events) {
				if (event.t > snapshot.upTo) events.push(event);
			}
		}
		for (const event of this.buffer) events.push(event);

		return foldSignals(events, mergeSignals(priors), this.foldOptions());
	}

	/**
	 * Fold this shard's log into its snapshot and truncate the log.
	 *
	 * ORDER MATTERS: snapshot FIRST, truncate SECOND. A crash between the two leaves both
	 * the snapshot and the full log on disk — which would double-count every event, except
	 * that the snapshot records `upTo`, the timestamp of the newest event it consumed, and
	 * `readIndex()` skips log events at or below it. So a crash at any point in this
	 * sequence costs nothing: worst case the log is replayed and the watermark discards it.
	 *
	 * `livePaths` (from `vault.getMarkdownFiles()`) drops aggregates for notes that no
	 * longer exist. Omit it and nothing is pruned by path — never guess a note is gone.
	 */
	async compact(livePaths?: Set<string> | null, now: number = Date.now()): Promise<void> {
		await this.init();
		const adapter = this.app.vault.adapter;

		const snapshot = await this.readSnapshot(this.snapshotPath);
		const parsed = parseSignalLog(await this.readIfExists(this.logPath));
		const fresh = parsed.events.filter((event) => event.t > snapshot.upTo);

		let index = foldSignals(fresh, snapshot.index, this.foldOptions());
		index = pruneSignals(index, livePaths ?? null, now, this.opts.retentionMs);

		let upTo = snapshot.upTo;
		for (const event of parsed.events) if (event.t > upTo) upTo = event.t;

		const payload: SignalsSnapshot = {
			version: SNAPSHOT_VERSION,
			writerId: this.writerId,
			generatedAt: now,
			upTo,
			index,
		};
		await adapter.write(this.snapshotPath, JSON.stringify(payload));
		await adapter.write(this.logPath, "");
		this.lines = 0;
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
		const payload = events.map(serializeEvent).join("");
		// One `append` per batch. The adapter creates the file if it is missing.
		await this.app.vault.adapter.append(this.logPath, payload);
		this.lines += events.length;
		if (this.lines >= this.opts.maxLines) await this.compact();
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
	 *  never to a crash on load. */
	private async readSnapshot(path: string): Promise<{ index: SignalsIndex; upTo: number }> {
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
		const upTo = typeof snapshot.upTo === "number" && Number.isFinite(snapshot.upTo) ? snapshot.upTo : 0;
		return { index: snapshot.index, upTo };
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

function countLines(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim() !== "") count += 1;
	}
	return count;
}
