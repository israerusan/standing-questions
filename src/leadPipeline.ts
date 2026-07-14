import { Notice, TFile, type App } from "obsidian";
import { appendLead, selectLeads, type Lead } from "./core/leads.mjs";
import { keywordLeads } from "./core/keywordLeads.mjs";
import { chunkNote } from "./shared/engine/chunk.mjs";
import { isExcluded, type QuestionIndex, type QuestionRecord } from "./questionIndex";
import type { QuestionEngineIndex } from "./engineIndex";
import { LEAD_DEBOUNCE_MS, type StandingQuestionsSettings } from "./settings";

/** How long a lead notice stays up. Long enough to read a question and press a button. */
const LEAD_NOTICE_MS = 15_000;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * What the pipeline needs from the plugin. A structural interface, not the plugin class, so
 * the whole thing can be driven in a test with a stub — including the path this add-on will
 * spend most of its life on: NO ENGINE INSTALLED.
 */
export interface LeadHost {
	app: App;
	settings: StandingQuestionsSettings;
	index: QuestionIndex;
	engineIndex: QuestionEngineIndex;
	/** Pro AND desktop AND an installed engine. Three conditions; the UI must not conflate them. */
	canUseSemanticPro(): boolean;
}

/**
 * "This may answer a question you asked in January."
 *
 * The debounced modify -> chunk -> embed -> cosine pipeline (DESIGN 8.2), and its free
 * keyword twin. Both funnel into the SAME gate (`selectLeads`) and the same UI, so the free
 * tier is not a different product with a worse feel — it is the same product with a weaker
 * matcher.
 *
 * THE DESIGN CONSTRAINT THAT MATTERS MOST IS RESTRAINT. This thing interrupts you. It fires
 * on a note you are still writing, about a question you asked months ago, and if it is wrong
 * more than occasionally you will turn it off and never turn it back on. Hence: a
 * conservative default threshold, notify-only (nothing is ever written into a note without a
 * click, unless the user opts in), at most `maxLeads` notices per pass, and a hard skip for
 * any question that already links the note.
 */
export class LeadPipeline {
	private timers = new Map<string, number>();
	/** Per-path generation. A newer edit lands while a query is in flight ⇒ the old result is dropped. */
	private generation = new Map<string, number>();

	constructor(private readonly host: LeadHost) {}

	/** A note changed. Nothing happens for LEAD_DEBOUNCE_MS, and nothing at all if it changes again. */
	schedule(path: string): void {
		const existing = this.timers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			path,
			window.setTimeout(() => {
				this.timers.delete(path);
				void this.run(path, false);
			}, LEAD_DEBOUNCE_MS)
		);
	}

	forget(path: string): void {
		const timer = this.timers.get(path);
		if (timer !== undefined) window.clearTimeout(timer);
		this.timers.delete(path);
		this.generation.delete(path);
	}

	dispose(): void {
		for (const timer of this.timers.values()) window.clearTimeout(timer);
		this.timers.clear();
		this.generation.clear();
	}

	/**
	 * @param manual true from the "Find leads for open questions" command — which bypasses the
	 *   length floor (the user asked; a 200-character note is their business) and reports the
	 *   empty case out loud, because a command that silently does nothing looks broken.
	 * @returns how many leads were surfaced
	 */
	async run(path: string, manual: boolean): Promise<number> {
		const { app, settings, index } = this.host;

		const file = app.vault.getFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") return 0;
		if (isExcluded(file.path, settings.excludeFolders)) return 0;
		// A question is not an answer to another question. (Sub-questions are the DAG's job.)
		if (index.isQuestion(file.path)) {
			if (manual) new Notice("This note is a question. Leads are found FOR questions, not from them.");
			return 0;
		}

		const questions = index.unanswered();
		if (questions.length === 0) {
			if (manual) new Notice("No open questions in this vault.");
			return 0;
		}

		const body = await app.vault.cachedRead(file);
		if (!manual && body.length < settings.minLeadChars) return 0;

		const generation = (this.generation.get(file.path) ?? 0) + 1;
		this.generation.set(file.path, generation);

		const hits: Lead[] = [];
		const semantic = this.host.canUseSemanticPro() && settings.semanticLeadsEnabled;
		if (semantic) {
			try {
				hits.push(...(await this.semanticHits(file, body, questions)));
			} catch (error) {
				// The engine dying must not take the free matcher down with it. Log, degrade, carry on
				// — and do NOT raise a Notice: a background pipeline that shouts about an engine the
				// user cannot see is worse than one that quietly works less well.
				console.error("standing-questions: the semantic lead query failed", error);
			}
		}
		if (settings.keywordLeadsEnabled) {
			hits.push(...this.keywordHits(file, body, questions));
		}

		// The note changed again while we were embedding it. Whatever we found describes a version
		// of the note that no longer exists.
		if (this.generation.get(file.path) !== generation) return 0;

		const selected = selectLeads(hits, {
			leadMinScore: settings.leadMinScore,
			leadAutoAppend: settings.leadAutoAppend,
			leadAutoAppendScore: settings.leadAutoAppendScore,
			maxLeads: settings.maxLeads,
			// A question that already links this note has already been told. Re-offering it is the
			// single most annoying thing this add-on could do.
			excludeQuestions: questions
				.filter((question) => this.alreadyLinks(question.path, file.path))
				.map((question) => question.path),
		});

		for (const lead of selected.autoAppend) await this.append(lead);
		for (const lead of selected.notify) this.notify(lead);

		const total = selected.autoAppend.length + selected.notify.length;
		if (manual && total === 0) new Notice("No open question looks like it is answered by this note.");
		return total;
	}

	/** Pro. Chunk the note, ask the engine which open questions each chunk is close to. */
	private async semanticHits(file: TFile, body: string, questions: QuestionRecord[]): Promise<Lead[]> {
		const chunks = chunkNote(body);
		if (chunks.length === 0) return [];

		const results = await this.host.engineIndex.query(
			chunks.map((chunk) => chunk.text),
			{ k: 3, minScore: this.host.settings.leadMinScore }
		);

		const byPath = new Map(questions.map((question) => [question.path, question]));
		const leads: Lead[] = [];
		for (const result of results) {
			for (const hit of result.hits ?? []) {
				const question = byPath.get(hit.note);
				if (!question) continue; // Answered, excluded, or deleted since the index was written.
				leads.push({
					question: question.path,
					questionTitle: question.title,
					link: this.linkText(file, question.path),
					score: hit.score,
					preview: hit.preview,
				});
			}
		}
		return leads;
	}

	/** Free. Title/heading token overlap, plus "we both link to the same note". */
	private keywordHits(file: TFile, body: string, questions: QuestionRecord[]): Lead[] {
		const { app, settings } = this.host;
		const cache = app.metadataCache.getFileCache(file);
		const preview = stripFrontmatter(body).replace(/\s+/g, " ").trim();

		const raw = keywordLeads(
			{
				path: file.path,
				title: file.basename,
				headings: (cache?.headings ?? []).map((heading) => heading.heading),
				links: Object.keys(app.metadataCache.resolvedLinks[file.path] ?? {}),
			},
			questions.map((question) => ({
				path: question.path,
				title: question.title,
				status: question.propagated,
				text: question.text,
				links: question.links,
			})),
			{ maxLeads: settings.maxLeads }
		);

		return raw.map((lead) => ({
			question: lead.question,
			questionTitle: lead.questionTitle,
			link: this.linkText(file, lead.question),
			reason: lead.reason,
			preview,
		}));
	}

	/**
	 * The notice. It names the question, says WHEN it was asked (which is the whole emotional
	 * point — "you asked this in January and you have just answered it without noticing"), and
	 * offers exactly two actions. It never writes anything by itself.
	 */
	private notify(lead: Lead): void {
		const question = this.host.app.vault.getFileByPath(lead.question);
		const asked = question instanceof TFile ? askedWhen(question.stat.ctime) : "";

		const fragment = createFragment((el) => {
			el.createSpan({
				text: asked
					? `This may answer a question you asked in ${asked}: `
					: "This may answer an open question: ",
			});
			el.createEl("strong", { text: lead.questionTitle ?? lead.question });
			if (typeof lead.score === "number") {
				el.createSpan({ cls: "standing-questions-lead-score", text: ` ${lead.score.toFixed(2)}` });
			}

			const actions = el.createDiv({ cls: "standing-questions-lead-actions" });
			const add = actions.createEl("button", { text: "Add lead" });
			add.addEventListener("click", () => {
				void this.append(lead);
			});
			const open = actions.createEl("button", { text: "Open question" });
			open.addEventListener("click", () => {
				if (question instanceof TFile) void this.host.app.workspace.getLeaf(false).openFile(question);
			});
		});

		new Notice(fragment, LEAD_NOTICE_MS);
	}

	/**
	 * Write the lead under `## Leads` in the QUESTION note.
	 *
	 * `Vault.process`, never `Vault.modify`: process gives us the note's current bytes and takes
	 * our transform atomically, so a lead cannot clobber an edit the user made in the two seconds
	 * since we read it. `appendLead` is idempotent, so a double click is a no-op.
	 */
	async append(lead: Lead): Promise<void> {
		const file = this.host.app.vault.getFileByPath(lead.question);
		if (!(file instanceof TFile)) return;
		await this.host.app.vault.process(file, (data) => appendLead(data, lead));
		new Notice(`Lead added to "${file.basename}".`);
	}

	/** The shortest link text that unambiguously resolves back to `file` from the question. */
	private linkText(file: TFile, fromPath: string): string {
		return this.host.app.metadataCache.fileToLinktext(file, fromPath, true);
	}

	/** Does the question already link this note? Then it has already been told about it. */
	private alreadyLinks(questionPath: string, notePath: string): boolean {
		const links = this.host.app.metadataCache.resolvedLinks[questionPath] ?? {};
		return Object.prototype.hasOwnProperty.call(links, notePath);
	}
}

/** "January" for this year, "January 2025" for any other. */
export function askedWhen(ctime: number, now: number = Date.now()): string {
	if (!Number.isFinite(ctime) || ctime <= 0) return "";
	const then = new Date(ctime);
	const month = then.toLocaleString(undefined, { month: "long" });
	return then.getFullYear() === new Date(now).getFullYear()
		? month
		: `${month} ${String(then.getFullYear())}`;
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(FRONTMATTER_RE, "");
}
