import { TFile, type App } from "obsidian";
import { chunkNote, CHUNK_NS, type Chunk } from "./shared/engine/chunk.mjs";
import { ENGINE_DIM } from "./shared/engine/engineRelease.mjs";
import type { EngineHost } from "./shared/engine/EngineHost";
import type { QuestionRecord } from "./questionIndex";

/**
 * The engine's view of the vault's questions (DESIGN 6.2). Everything here is Pro + desktop +
 * an installed engine; every method returns a benign value when any of those is false, so no
 * caller has to remember to check three things.
 *
 * The plugin chunks; the sidecar embeds and stores. The chunker is VENDORED and byte-checked
 * against obsidian-plugin-core because Prior Art writes into the same index in the same
 * namespace — two add-ons that chunk differently produce two incoherent halves of one index,
 * and nothing errors, it just quietly stops finding things.
 */

interface QueryHit {
	key: string;
	note: string;
	ord: number;
	score: number;
	heading: string;
	preview: string;
}

interface QueryResult {
	i: number;
	hits: QueryHit[];
}

interface OpenResult {
	chunks: number;
	notes: number;
	created: boolean;
}

interface UpsertResult {
	embedded: number;
	skipped: number;
	removed: number;
}

export class QuestionEngineIndex {
	/** Path -> the mtime we last sent. The diff that keeps `sync()` from re-embedding the vault. */
	private indexed = new Map<string, number>();
	private opening: Promise<boolean> | null = null;
	private opened = false;

	constructor(
		private readonly app: App,
		private readonly getHost: () => EngineHost | null
	) {}

	/** Forget what we believe the engine holds. Called when the engine is removed or replaced. */
	reset(): void {
		this.indexed.clear();
		this.opened = false;
		this.opening = null;
	}

	/**
	 * Bind the engine to this vault's index. Exactly once per process (the broker guarantees
	 * one engine and one vault), and idempotent under concurrent callers.
	 *
	 * This is also the first thing that would SPAWN the child process — and it is only ever
	 * reached from a Pro user's explicit action or from the debounced lead pipeline they turned
	 * on. Nothing here runs at onload().
	 */
	async ensureOpen(): Promise<boolean> {
		if (this.opened) return true;
		const host = this.getHost();
		if (!host) return false;
		if (this.opening) return this.opening;

		this.opening = (async () => {
			try {
				const health = await host.ensureStarted();
				if (!health) return false;
				await host.request<OpenResult>("open", {
					vaultKey: host.vaultKey(),
					dim: health.dim || ENGINE_DIM,
				});
				this.opened = true;
				return true;
			} catch (error) {
				console.error("standing-questions: could not open the engine index", error);
				return false;
			} finally {
				this.opening = null;
			}
		})();
		return this.opening;
	}

	/**
	 * Make the engine's `questions` namespace match the vault's.
	 *
	 * A full diff rather than an event-by-event upkeep: it is idempotent, it self-heals after a
	 * crash or an engine reinstall, and it costs nothing when nothing changed (the sidecar skips
	 * chunks whose key it already holds without re-embedding them).
	 */
	async sync(records: QuestionRecord[]): Promise<void> {
		if (!(await this.ensureOpen())) return;

		const live = new Set(records.map((record) => record.path));
		const stale = [...this.indexed.keys()].filter((path) => !live.has(path));
		if (stale.length > 0) await this.remove(stale);

		for (const record of records) {
			if (this.indexed.get(record.path) === record.mtime) continue;
			await this.upsert(record);
		}
	}

	async upsert(record: QuestionRecord): Promise<void> {
		const host = this.getHost();
		if (!host || !(await this.ensureOpen())) return;

		const file = this.app.vault.getFileByPath(record.path);
		if (!(file instanceof TFile)) return;
		const body = await this.app.vault.cachedRead(file);

		// The title carries most of a question's meaning ("Why did we drop the CRDT plan?") and a
		// question's body is often one line. Embedding the title WITH the body is the difference
		// between matching and not.
		const chunks: Chunk[] = chunkNote(`# ${record.title}\n\n${body}`);
		if (chunks.length === 0) return;

		try {
			await host.request<UpsertResult>("upsert", {
				ns: CHUNK_NS.QUESTIONS,
				note: record.path,
				mtime: record.mtime,
				chunks,
			});
			this.indexed.set(record.path, record.mtime);
		} catch (error) {
			console.error(`standing-questions: could not index ${record.path}`, error);
		}
	}

	async remove(paths: string[]): Promise<void> {
		const host = this.getHost();
		if (!host || paths.length === 0 || !this.opened) return;
		try {
			await host.request("delete", { ns: CHUNK_NS.QUESTIONS, notes: paths });
		} catch (error) {
			console.error("standing-questions: could not remove questions from the index", error);
		}
		for (const path of paths) this.indexed.delete(path);
	}

	async rename(from: string, to: string): Promise<void> {
		const host = this.getHost();
		if (!host || !this.opened) return;
		try {
			// Vectors are untouched — chunk keys are content hashes, so a rename is metadata only.
			await host.request("rename", { ns: CHUNK_NS.QUESTIONS, from, to });
			const mtime = this.indexed.get(from);
			this.indexed.delete(from);
			if (mtime !== undefined) this.indexed.set(to, mtime);
		} catch (error) {
			console.error("standing-questions: could not rename a question in the index", error);
		}
	}

	/** Drop the whole namespace and re-embed. The settings "Rebuild index" button. */
	async rebuild(records: QuestionRecord[]): Promise<number> {
		if (!(await this.ensureOpen())) return 0;
		await this.remove([...this.indexed.keys()]);
		this.indexed.clear();
		for (const record of records) await this.upsert(record);
		return this.indexed.size;
	}

	/**
	 * N passages in, N ranked hit-lists out. `minScore` is applied by the SIDECAR, so a query
	 * that finds nothing costs one round trip and no JSON.
	 *
	 * Deliberately no `cancel`: this pipeline is debounced 2.5 s per path, not per keystroke, so
	 * a superseding query is rare — and a stale result is discarded by the caller's generation
	 * counter anyway. (Prior Art, which queries as you type, is the one that needs cancel.)
	 */
	async query(texts: string[], options: { k?: number; minScore: number }): Promise<QueryResult[]> {
		const host = this.getHost();
		if (!host || texts.length === 0 || !(await this.ensureOpen())) return [];
		const result = await host.request<{ results: QueryResult[] }>("query", {
			ns: CHUNK_NS.QUESTIONS,
			texts,
			k: options.k ?? 3,
			minScore: options.minScore,
		});
		return result?.results ?? [];
	}

	/** How many question notes we believe the engine currently holds. For the settings tab. */
	size(): number {
		return this.indexed.size;
	}
}
