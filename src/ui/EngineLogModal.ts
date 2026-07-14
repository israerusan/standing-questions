import { Modal, Notice, type App } from "obsidian";

/**
 * The engine's last 200 stderr lines, verbatim.
 *
 * This exists because the alternative — a plugin that runs a native binary and shows the user
 * nothing about what it said — is exactly the shape of thing a reviewer, and a suspicious
 * user, is right to distrust. If the engine dies, the reason is in here, and it is copyable.
 */
export class EngineLogModal extends Modal {
	constructor(
		app: App,
		private readonly lines: string[]
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Engine log");
		contentEl.addClass("standing-questions-engine-log");

		if (this.lines.length === 0) {
			contentEl.createEl("p", { text: "The engine has not written anything. It may never have started." });
			return;
		}

		contentEl.createEl("p", {
			cls: "standing-questions-engine-log-note",
			text: "The last 200 lines the engine wrote to its error stream, oldest first.",
		});
		// createEl with `text`, never innerHTML: these lines come from a subprocess, and a
		// subprocess's output is untrusted input by definition.
		contentEl.createEl("pre", { text: this.lines.join("\n") });

		const actions = contentEl.createDiv({ cls: "standing-questions-engine-log-actions" });
		const copy = actions.createEl("button", { text: "Copy" });
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.lines.join("\n")).then(
				() => new Notice("Engine log copied."),
				() => new Notice("Could not copy the log.")
			);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
