/**
 * EngineInstallModal — THE CONSENT GATE.
 *
 * Nothing is downloaded, extracted, made executable, or run until the user clicks
 * "Download and run" in this modal. A download at onload() with no consent is
 * exactly the dropper shape reviewers hardened against after PhantomPulse, and it
 * would break the portfolio's own "never phones home" invariant. `EngineHost.install()`
 * has ONE legitimate caller and it is this file's confirm handler.
 *
 * The modal must name, in plain words the user can check:
 *   - that an executable will be downloaded AND RUN on their computer
 *   - the exact URL it comes from
 *   - the version
 *   - the SHA-256 it must match, and that it is verified before anything runs
 *   - where on disk it lands (outside the vault — DESIGN 7.1)
 *   - what it does with their notes, and that it opens no network connections
 *
 * Copy is DESIGN 7.2, near-verbatim. Do not soften it: a modal that undersells what
 * is about to happen is worse than no modal, both ethically and in review.
 *
 * DOM: createEl / createDiv / createSpan only. No innerHTML, no insertAdjacentHTML,
 * no `el.style.x = ...`. Every plugin's styles.css must carry the block at the
 * bottom of this file.
 */
import { Modal, Setting, type App } from "obsidian";
import type { InstallPlan } from "./installPlan.mjs";

export interface EngineInstallModalOptions {
	plan: InstallPlan;
	/** Absolute directory the onedir will be extracted into. Shown verbatim. */
	installDir: string;
	/** Approximate download size, e.g. "about 45 MB". Optional — omitted rather than guessed wrong. */
	downloadSizeLabel?: string;
	/** Called only on "Download and run". */
	onConfirm: () => void;
	onCancel?: () => void;
}

const SOURCE_REPO_URL = "https://github.com/israerusan/second-read-engine";

export class EngineInstallModal extends Modal {
	private readonly options: EngineInstallModalOptions;
	private confirmed = false;

	constructor(app: App, options: EngineInstallModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		const { plan, installDir, downloadSizeLabel } = this.options;

		contentEl.addClass("second-read-engine-modal");
		titleEl.setText("Download the semantic engine");

		contentEl.createEl("p", {
			cls: "second-read-engine-lede",
			text: "Second Read will download a program and run it on your computer.",
		});

		const facts = contentEl.createDiv({ cls: "second-read-engine-facts" });
		this.fact(facts, "From", plan.url);
		this.fact(facts, "Version", plan.version);
		this.fact(facts, "SHA-256", plan.sha256, "verified before anything is run");
		this.fact(facts, "Installs to", installDir);
		if (downloadSizeLabel) this.fact(facts, "Size", downloadSizeLabel);

		contentEl.createEl("p", {
			cls: "second-read-engine-explainer",
			text:
				"The engine embeds your notes locally so Second Read can find related ones. It reads only the text " +
				"this add-on sends it, it opens no network connections, and it stops when Obsidian closes.",
		});

		const source = contentEl.createEl("p", { cls: "second-read-engine-source" });
		source.createSpan({ text: "Source: " });
		source.createEl("a", {
			text: "github.com/israerusan/second-read-engine",
			href: SOURCE_REPO_URL,
			attr: { target: "_blank", rel: "noopener noreferrer" },
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Download and run")
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						this.options.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.options.onCancel?.();
	}

	/** A label / value row. The value is selectable text so the user can check it themselves. */
	private fact(parent: HTMLElement, label: string, value: string, note?: string): void {
		const row = parent.createDiv({ cls: "second-read-engine-fact" });
		row.createSpan({ cls: "second-read-engine-fact-label", text: label });
		const val = row.createDiv({ cls: "second-read-engine-fact-value" });
		val.createSpan({ cls: "second-read-engine-fact-text", text: value });
		if (note) val.createSpan({ cls: "second-read-engine-fact-note", text: note });
	}
}

/*
 * ---------------------------------------------------------------------------
 * Every plugin that vendors this file MUST paste this block into its styles.css.
 * (Styling lives in CSS, never in `el.style.x = ...` — the `no-static-styles-
 * assignment` rule, and a `<style>` element is banned outright.)
 * ---------------------------------------------------------------------------
 *
 * .second-read-engine-modal .second-read-engine-lede {
 *   font-weight: var(--font-semibold);
 * }
 * .second-read-engine-facts {
 *   display: grid;
 *   grid-template-columns: auto 1fr;
 *   gap: var(--size-2-2) var(--size-4-3);
 *   margin: var(--size-4-3) 0;
 *   padding: var(--size-4-2);
 *   border: 1px solid var(--background-modifier-border);
 *   border-radius: var(--radius-s);
 *   background-color: var(--background-secondary);
 * }
 * .second-read-engine-fact {
 *   display: contents;
 * }
 * .second-read-engine-fact-label {
 *   color: var(--text-muted);
 *   font-size: var(--font-ui-smaller);
 * }
 * .second-read-engine-fact-value {
 *   min-width: 0;
 * }
 * .second-read-engine-fact-text {
 *   display: block;
 *   font-family: var(--font-monospace);
 *   font-size: var(--font-ui-smaller);
 *   overflow-wrap: anywhere;
 *   user-select: text;
 * }
 * .second-read-engine-fact-note {
 *   display: block;
 *   color: var(--text-muted);
 *   font-size: var(--font-ui-smaller);
 * }
 * .second-read-engine-explainer,
 * .second-read-engine-source {
 *   color: var(--text-muted);
 *   font-size: var(--font-ui-small);
 * }
 */
