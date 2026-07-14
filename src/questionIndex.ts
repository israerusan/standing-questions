import { TFile, type App, type CachedMetadata } from "obsidian";
import { parseQuestion, type QuestionStatus } from "./core/questionParse.mjs";
import {
	buildDag,
	propagateStatus,
	statusChanges,
	treeOrder,
	type QuestionDag,
	type StatusChange,
	type TreeRow,
} from "./core/questionDag.mjs";
import type { StandingQuestionsSettings } from "./settings";

export interface QuestionRecord {
	/** The note path. The DAG's node id. */
	id: string;
	path: string;
	title: string;
	/** As written in the note. */
	status: QuestionStatus;
	/** After propagation. Equal to `status` in a healthy, settled vault. */
	propagated: QuestionStatus;
	/** Resolved parent paths. Parents that resolve to nothing are dropped (a dangling link). */
	parents: string[];
	/** The parent LINK TEXT, before resolution — what the note actually says. */
	rawParents: string[];
	/** Resolved outgoing links, for the free lead matcher's "shared link" signal. */
	links: string[];
	/** The body, frontmatter stripped, truncated. Keyword tokens only — never the whole vault in RAM. */
	text: string;
	mtime: number;
	/** True when this question sits in a `parent::` loop. Its status is left exactly as written. */
	inCycle: boolean;
}

/** How much of a question's body is kept for the free keyword matcher. */
const QUESTION_TEXT_CHARS = 600;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Every `type: question` note in the vault, its DAG, and the status each question would have
 * if its sub-questions were taken seriously.
 *
 * Rebuilding is async for one reason: the inline `parent::` form lives in the BODY, and
 * Obsidian's metadata cache does not parse inline fields (Dataview is not a dependency). So
 * the frontmatter pass is synchronous and cheap over the whole vault, and only the notes that
 * turn out to BE questions — a handful, not a vault — are read. A vault of 20 000 notes with
 * 40 questions does 40 reads, not 20 000.
 */
export class QuestionIndex {
	private records: QuestionRecord[] = [];
	private byPath = new Map<string, QuestionRecord>();
	private dag: QuestionDag = buildDag([]);
	private statuses = new Map<string, QuestionStatus>();

	constructor(
		private readonly app: App,
		private settings: StandingQuestionsSettings
	) {}

	updateSettings(settings: StandingQuestionsSettings): void {
		this.settings = settings;
	}

	all(): QuestionRecord[] {
		return this.records;
	}

	/** Questions worth matching a new note against: anything not already answered. */
	unanswered(): QuestionRecord[] {
		return this.records.filter((record) => record.propagated !== "answered");
	}

	get(path: string): QuestionRecord | undefined {
		return this.byPath.get(path);
	}

	isQuestion(path: string): boolean {
		return this.byPath.has(path);
	}

	cycles(): string[][] {
		return this.dag.cycles;
	}

	/** Roots first, depth-first through children — the order the board renders in. */
	tree(): TreeRow[] {
		return treeOrder(this.records, this.dag);
	}

	children(path: string): string[] {
		return this.dag.children.get(path) ?? [];
	}

	/** The notes whose written status disagrees with their propagated one. What the writer writes. */
	pendingChanges(): StatusChange[] {
		return statusChanges(this.records, this.statuses);
	}

	async rebuild(): Promise<void> {
		const keys = {
			typeKey: this.settings.typeKey,
			questionValue: this.settings.questionValue,
			statusKey: this.settings.statusKey,
			parentKey: this.settings.parentKey,
		};

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => !isExcluded(file.path, this.settings.excludeFolders));

		const drafts: Array<{ file: TFile; cache: CachedMetadata | null }> = [];
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			// Frontmatter alone decides QUESTION-NESS, and it is already in memory. Only the notes
			// that pass this gate are read from disk.
			if (!parseQuestion(cache?.frontmatter, "", keys).isQuestion) continue;
			drafts.push({ file, cache: cache ?? null });
		}

		const records: QuestionRecord[] = [];
		for (const { file, cache } of drafts) {
			// cachedRead, not read: this is a read-only pass and the cache is exactly what it is for.
			const body = await this.app.vault.cachedRead(file);
			const parsed = parseQuestion(cache?.frontmatter, body, keys);

			const parents: string[] = [];
			for (const raw of parsed.parents) {
				const target = this.app.metadataCache.getFirstLinkpathDest(raw, file.path);
				// A `parent:: [[typo]]` is a dangling link, which is an everyday state of a vault.
				// Drop the edge; never drop the note.
				if (target instanceof TFile && target.path !== file.path) parents.push(target.path);
			}

			records.push({
				id: file.path,
				path: file.path,
				title: file.basename,
				status: parsed.status,
				propagated: parsed.status,
				parents,
				rawParents: parsed.parents,
				links: Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}),
				text: stripFrontmatter(body).slice(0, QUESTION_TEXT_CHARS),
				mtime: file.stat.mtime,
				inCycle: false,
			});
		}

		this.dag = buildDag(records);
		this.statuses = propagateStatus(records, this.dag);
		for (const record of records) {
			record.propagated = this.statuses.get(record.id) ?? record.status;
			record.inCycle = this.dag.inCycle.has(record.id);
		}

		this.records = records;
		this.byPath = new Map(records.map((record) => [record.path, record]));
	}
}

/** A path is excluded when it is inside one of the folders, not merely prefixed by its name. */
export function isExcluded(path: string, folders: string[]): boolean {
	const target = path.replace(/\\/g, "/");
	return folders.some((folder) => {
		const clean = String(folder ?? "")
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "");
		if (clean === "") return false;
		return target === clean || target.startsWith(`${clean}/`);
	});
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_RE, "");
}
