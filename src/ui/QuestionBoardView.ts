import { ItemView, type WorkspaceLeaf } from "obsidian";
import type StandingQuestionsPlugin from "../main";
import type { QuestionRecord } from "../questionIndex";
import type { QuestionStatus } from "../core/questionParse.mjs";

export const VIEW_TYPE_QUESTION_BOARD = "standing-questions-board";

const COLUMNS: Array<{ status: QuestionStatus; title: string; empty: string }> = [
	{ status: "open", title: "Open", empty: "No open questions." },
	{ status: "partial", title: "Partial", empty: "Nothing part-answered." },
	{ status: "answered", title: "Answered", empty: "Nothing answered yet." },
];

/**
 * The board. Three columns, tree-indented by the DAG, and it is the whole free product's
 * shop window — it works with no engine, no license, and no network, on a phone.
 *
 * Rows are rendered from the PROPAGATED status, not the written one, because that is the
 * truth the user cares about: a parent question whose sub-questions are all answered IS
 * answered, whether or not the frontmatter has caught up yet (and it will not have, if the
 * user turned auto-propagation off).
 *
 * DOM is built with createDiv/createEl only — never innerHTML. Clicks are ONE delegated
 * listener on the container, registered through `registerDomEvent` so it is torn down with
 * the view.
 */
export class QuestionBoardView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: StandingQuestionsPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_QUESTION_BOARD;
	}

	getDisplayText(): string {
		return "Question board";
	}

	getIcon(): string {
		return "help-circle";
	}

	protected async onOpen(): Promise<void> {
		this.registerDomEvent(this.contentEl, "click", (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const row = target.closest("[data-question-path]");
			if (!(row instanceof HTMLElement)) return;
			const path = row.dataset.questionPath;
			if (path) void this.plugin.openNote(path, event);
		});
		this.render();
	}

	render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("standing-questions-board");

		const rows = this.plugin.index.tree();
		const records = new Map(this.plugin.index.all().map((record) => [record.path, record]));

		const header = root.createDiv({ cls: "standing-questions-board-header" });
		header.createDiv({
			cls: "standing-questions-board-count",
			text: `${rows.length} question${rows.length === 1 ? "" : "s"}`,
		});

		// A `parent::` loop is a data bug in the user's vault, and it silently disables
		// propagation for every question inside it. Say so, in the place they are looking.
		const cycles = this.plugin.index.cycles();
		if (cycles.length > 0) {
			const warning = root.createDiv({ cls: "standing-questions-cycle-warning" });
			warning.createSpan({
				text:
					`${cycles.length} question${cycles.length === 1 ? "" : "s"} form a parent loop. ` +
					"Their statuses are left exactly as you wrote them — nothing is propagated through a loop.",
			});
			for (const cycle of cycles) {
				warning.createDiv({
					cls: "standing-questions-cycle-members",
					text: cycle.map((path) => basename(path)).join(" → ") + " → …",
				});
			}
		}

		if (rows.length === 0) {
			root.createDiv({
				cls: "standing-questions-empty",
				text: "No questions yet. Add `type: question` to a note's frontmatter, or run \"Create a question note\".",
			});
			return;
		}

		const columns = root.createDiv({ cls: "standing-questions-columns" });
		for (const column of COLUMNS) {
			const box = columns.createDiv({ cls: "standing-questions-column" });
			box.dataset.status = column.status;
			const heading = box.createDiv({ cls: "standing-questions-column-header" });
			heading.createSpan({ cls: "standing-questions-column-title", text: column.title });

			const list = box.createDiv({ cls: "standing-questions-list" });
			let count = 0;
			for (const row of rows) {
				const record = records.get(row.node.id);
				if (!record || record.propagated !== column.status) continue;
				count++;
				this.renderRow(list, record, row.depth);
			}
			heading.createSpan({ cls: "standing-questions-column-count", text: String(count) });
			if (count === 0) list.createDiv({ cls: "standing-questions-empty", text: column.empty });
		}
	}

	private renderRow(parent: HTMLElement, record: QuestionRecord, depth: number): void {
		const row = parent.createDiv({ cls: "standing-questions-row" });
		row.dataset.questionPath = record.path;
		// Indentation is an ATTRIBUTE, styled in styles.css — never `el.style.paddingLeft`
		// (`no-static-styles-assignment`), and never an injected <style> element.
		row.dataset.depth = String(Math.min(depth, 5));

		const title = row.createDiv({ cls: "standing-questions-row-title", text: record.title });
		if (record.inCycle) {
			title.createSpan({ cls: "standing-questions-row-flag", text: "loop" });
		} else if (record.propagated !== record.status) {
			// The board shows the propagated truth; this says the NOTE has not caught up. It is the
			// visible half of "auto-propagation is off" — otherwise that setting is invisible magic.
			title.createSpan({
				cls: "standing-questions-row-flag",
				text: `${record.status} in the note`,
			});
		}

		const children = this.plugin.index.children(record.path);
		if (children.length > 0) {
			row.createDiv({
				cls: "standing-questions-row-meta",
				text: `${children.length} sub-question${children.length === 1 ? "" : "s"}`,
			});
		}
	}
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash === -1 ? path : path.slice(slash + 1);
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}
