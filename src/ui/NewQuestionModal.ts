import { Modal, Setting, type App } from "obsidian";

/**
 * "What do you want to know?" — the one place a question is born.
 *
 * A question note is just frontmatter, so this could have been a command that creates
 * "Untitled" and lets the user rename it. It is not, because the TITLE IS THE QUESTION: the
 * whole add-on matches notes against question titles, and a vault full of `Untitled 3` would
 * be a vault full of questions nothing can ever answer.
 */
export class NewQuestionModal extends Modal {
	private title = "";
	private parent = "";

	constructor(
		app: App,
		private readonly onSubmit: (title: string, parent: string) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Create a question note");

		new Setting(contentEl)
			.setName("Question")
			.setDesc("Phrase it as a question. It is what every new note gets matched against.")
			.addText((text) => {
				text.setPlaceholder("Why did we drop the CRDT plan?").onChange((value) => {
					this.title = value;
				});
				text.inputEl.addClass("standing-questions-new-input");
			});

		new Setting(contentEl)
			.setName("Parent question")
			.setDesc("Optional. The bigger question this one is part of — answering all of its children answers it.")
			.addText((text) =>
				text.setPlaceholder("A bigger question").onChange((value) => {
					this.parent = value;
				})
			);

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					const title = this.title.trim();
					if (title === "") return;
					this.close();
					this.onSubmit(title, this.parent.trim());
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
