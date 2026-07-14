import { MarkdownView, Notice, TFile } from "obsidian";
import type StandingQuestionsPlugin from "./main";
import { NewQuestionModal } from "./ui/NewQuestionModal";

/**
 * Every command, in one place.
 *
 * Sentence case, no add-on name in the name (the review rejects "Standing Questions: open
 * board"), no default hotkeys (the guidelines forbid them and the review checks).
 *
 * "Find leads for open questions" is a `checkCallback` that returns FALSE unless the note can
 * actually be matched — so it is HIDDEN from the palette rather than present and always
 * failing with a sales Notice. A command that can only ever show an ad is not a command.
 * Note what it does NOT check: Pro. The FREE keyword matcher is a real matcher, and a free
 * user running this command gets real leads.
 */
export function registerCommands(plugin: StandingQuestionsPlugin): void {
	plugin.addCommand({
		id: "open-question-board",
		name: "Open question board",
		callback: () => {
			void plugin.activateBoard();
		},
	});

	plugin.addCommand({
		id: "new-question",
		name: "Create a question note",
		callback: () => {
			new NewQuestionModal(plugin.app, (title, parent) => {
				void plugin.createQuestion(title, parent);
			}).open();
		},
	});

	plugin.addCommand({
		id: "mark-answered",
		name: "Mark this question answered",
		checkCallback: (checking) => {
			const file = activeMarkdown(plugin);
			if (!file || !plugin.index.isQuestion(file.path)) return false;
			if (!checking) void plugin.setStatus(file, "answered");
			return true;
		},
	});

	plugin.addCommand({
		id: "propagate-statuses",
		name: "Propagate question statuses",
		callback: () => {
			void plugin.propagateStatuses(true);
		},
	});

	plugin.addCommand({
		id: "find-leads-now",
		name: "Find leads for open questions",
		checkCallback: (checking) => {
			const file = activeMarkdown(plugin);
			// Hidden on a question note (a question is not a lead for another question) and when
			// there is nothing to match against.
			if (!file || plugin.index.isQuestion(file.path)) return false;
			if (plugin.index.unanswered().length === 0) return false;
			if (!checking) void plugin.findLeads(file);
			return true;
		},
	});
}

function activeMarkdown(plugin: StandingQuestionsPlugin): TFile | null {
	const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
	return file instanceof TFile && file.extension === "md" ? file : null;
}

/** Notices live here too, so the plugin body stays free of copy. */
export function noticePropagated(count: number): void {
	new Notice(
		count === 0
			? "Every question's status already matches its sub-questions."
			: `Updated ${String(count)} question${count === 1 ? "" : "s"}.`
	);
}
