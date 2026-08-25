import { Notice, PluginSettingTab, Setting } from "obsidian";
import type StandingQuestionsPlugin from "../main";
import { createExternalLink } from "./links";
import { EngineLogModal } from "./EngineLogModal";
import {
	PRO_NAME,
	PRO_PRICE_LABEL,
	PRO_TAGLINE,
	PRO_UNLOCK_SUMMARY,
	PURCHASE_URL,
	SUITE_NAME,
} from "../product";
import { FEATURES } from "../core/features.mjs";
import { proFeatureKeys } from "../shared/featureGates.mjs";
import { EngineInstallModal } from "../shared/engine/EngineInstallModal";
import { ENGINE_RELEASE_PINNED, ENGINE_VERSION } from "../shared/engine/engineRelease.mjs";
import { engineInstallDir } from "../core/enginePaths.mjs";
import { nodeHostInfo } from "../nodeHost";
import type { InstallProgress } from "../shared/engine/EngineHost";

/** What the install actually costs, measured on the built win-x64 artifact. */
const DOWNLOAD_SIZE_LABEL = "about 50 MB (about 105 MB once unpacked)";

export class StandingQuestionsSettingTab extends PluginSettingTab {
	/** The in-settings progress row (DESIGN 7.2). Lives across renders of the engine box only. */
	private progressEl: HTMLElement | null = null;
	private installing = false;
	/** Guard: display() kicks one async status refresh, and the refresh re-displays exactly once. */
	private statusRequested = false;

	constructor(private plugin: StandingQuestionsPlugin) {
		super(plugin.app, plugin);
	}

	/** Nothing typed into a coalesced control may be lost when the tab closes. */
	hide(): void {
		void this.plugin.flushPendingSave();
	}

	display(): void {
		this.containerEl.empty();
		this.progressEl = null;

		this.renderLicense();
		this.renderQuestions();
		this.renderSubQuestions();
		this.renderLeads();
		this.renderPro();
		this.renderEngine();
		this.renderFeedback();

		// The engine's state is on disk, so reading it is async and display() is not. Ask once,
		// then re-render — never in a loop.
		if (this.plugin.engine && !this.plugin.engineStatus && !this.statusRequested) {
			this.statusRequested = true;
			void this.plugin.refreshEngineStatus().then(() => this.display());
		}
	}

	// --- gating primitives -----------------------------------------------------

	private markPro(setting: Setting): void {
		setting.nameEl.createSpan({ cls: "standing-questions-pro-pill", text: "Pro" });
	}

	private appendUpgrade(setting: Setting): void {
		setting.descEl.appendText(" ");
		createExternalLink(setting.descEl, {
			cls: "standing-questions-upgrade-inline",
			text: "Upgrade to Pro",
			url: PURCHASE_URL,
		});
	}

	/**
	 * A Pro row for a free user shows a disabled lock and a way to upgrade — never an empty
	 * right-hand side, which reads as a rendering bug rather than a paywall.
	 */
	private proRow(name: string, desc: string, render: (setting: Setting) => void): void {
		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		this.markPro(setting);
		if (!this.plugin.settings.isPro) {
			setting.settingEl.addClass("standing-questions-setting-locked");
			setting.addExtraButton((button) =>
				button.setIcon("lock").setDisabled(true).setTooltip("Pro feature")
			);
			this.appendUpgrade(setting);
			return;
		}
		render(setting);
	}

	// --- License (DESIGN 4.5) ---------------------------------------------------

	private renderLicense(): void {
		new Setting(this.containerEl).setName("License").setHeading();

		new Setting(this.containerEl)
			.setName("License key")
			.setDesc(
				`Verified offline with an Ed25519 signature built into the add-on — no account, no server, no network request. One ${SUITE_NAME} key unlocks Pro in all five add-ons.`
			)
			.addTextArea((text) => {
				text.inputEl.addClass("standing-questions-license-input");
				text.inputEl.rows = 3;
				text
					.setPlaceholder("Paste your license key")
					.setValue(this.plugin.settings.licenseKey)
					.onChange((value) => {
						this.plugin.settings.licenseKey = value;
						// Re-verify per keystroke (offline, microseconds) but only rebuild the tab when Pro
						// actually FLIPS — display() empties containerEl, which would destroy the textarea
						// the user is typing into.
						void this.plugin.refreshLicense(true, true).then((flipped) => {
							if (flipped) this.display();
						});
					});
			});

		const status = this.containerEl.createDiv({ cls: "standing-questions-license-status" });
		if (this.plugin.settings.isPro) {
			status.addClass("is-pro");
			const email = this.plugin.settings.licenseEmail;
			status.createEl("p", {
				text: `Pro active${email ? ` — ${email}` : ""}. This key also unlocks Note Decay, Effort Index, Prior Art, and Unwritten.`,
			});
			return;
		}

		if (this.plugin.licenseError) {
			status.createEl("p", {
				cls: "standing-questions-license-error",
				text: this.plugin.licenseError,
			});
		} else {
			status.createEl("p", {
				text: `Free tier. Pro unlocks ${PRO_UNLOCK_SUMMARY} — and the same key unlocks Pro in all five ${SUITE_NAME} add-ons.`,
			});
		}

		this.renderProCard(status);
	}

	/**
	 * The upgrade card. createDiv/createEl/createSpan only — NEVER innerHTML.
	 *
	 * The title is a styled div, not an <h4>: `no-manual-html-headings` rejects a hand-rolled
	 * heading element, and this is a card inside the License section, not a settings section of
	 * its own — a real `.setHeading()` here would put it in the tab's outline.
	 */
	private renderProCard(parent: HTMLElement): void {
		const card = parent.createDiv({ cls: "standing-questions-pro-card" });
		card.createDiv({
			cls: "standing-questions-pro-card-title",
			text: `${PRO_NAME} — ${PRO_PRICE_LABEL}`,
		});
		card.createEl("p", { text: PRO_TAGLINE });

		const list = card.createEl("ul");
		for (const key of proFeatureKeys(FEATURES)) {
			list.createEl("li", { text: FEATURES[key].label });
		}

		createExternalLink(card, {
			cls: "standing-questions-pro-btn",
			text: "Unlock Pro",
			url: PURCHASE_URL,
		});
	}

	// --- What counts as a question ----------------------------------------------

	private renderQuestions(): void {
		new Setting(this.containerEl).setName("Questions").setHeading();

		this.containerEl.createEl("p", {
			cls: "standing-questions-hint",
			text:
				`A note is a question when its frontmatter says so. Every key here is configurable, because "${this.plugin.settings.typeKey}", ` +
				`"${this.plugin.settings.statusKey}" and "${this.plugin.settings.parentKey}" are common enough to clash with a vault's own conventions.`,
		});

		const keys: Array<{
			key: "typeKey" | "questionValue" | "statusKey" | "parentKey";
			name: string;
			desc: string;
		}> = [
			{ key: "typeKey", name: "Type key", desc: "The frontmatter key that declares a note's kind." },
			{
				key: "questionValue",
				name: "Question value",
				desc: "The value of the type key that means this note is a question.",
			},
			{
				key: "statusKey",
				name: "Status key",
				desc: "Holds open, partial, or answered. An unrecognised value is treated as open — never as \"not a question\".",
			},
			{
				key: "parentKey",
				name: "Parent key",
				desc: "Accepted in frontmatter (parent: \"[[Bigger question]]\") and as an inline field (parent:: [[Bigger question]]).",
			},
		];

		for (const row of keys) {
			new Setting(this.containerEl)
				.setName(row.name)
				.setDesc(row.desc)
				.addText((text) =>
					text.setValue(this.plugin.settings[row.key]).onChange((value) => {
						const clean = value.trim();
						if (clean === "") return; // An empty key would make every note a question, or none.
						this.plugin.settings[row.key] = clean;
						this.plugin.queueSave();
					})
				);
		}

		new Setting(this.containerEl)
			.setName("Excluded folders")
			.setDesc("One per line. Notes in these folders are never indexed as questions and never scanned for leads.")
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text
					.setPlaceholder("Archive\nTemplates")
					.setValue(this.plugin.settings.excludeFolders.join("\n"))
					.onChange((value) => {
						this.plugin.settings.excludeFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line !== "");
						this.plugin.queueSave();
					});
			});
	}

	// --- Sub-questions ------------------------------------------------------------

	private renderSubQuestions(): void {
		new Setting(this.containerEl).setName("Sub-questions").setHeading();

		new Setting(this.containerEl)
			.setName("Propagate statuses upward")
			.setDesc(
				"When every sub-question is answered, the parent is answered; when some are, it is partial. " +
					"With this on, the status is written back into the parent note. With it off, the board still " +
					"shows the propagated status and your notes are never touched."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoPropagate).onChange(async (value) => {
					this.plugin.settings.autoPropagate = value;
					await this.plugin.saveSettings();
					if (value) await this.plugin.propagateStatuses();
				})
			);

		const pending = this.plugin.index.pendingChanges();
		new Setting(this.containerEl)
			.setName("Propagate now")
			.setDesc(
				pending.length === 0
					? "Every question's status already matches its sub-questions."
					: `${pending.length} question${pending.length === 1 ? "" : "s"} would change.`
			)
			.addButton((button) =>
				button
					.setButtonText("Propagate")
					.setDisabled(pending.length === 0)
					.onClick(async () => {
						await this.plugin.propagateStatuses();
						this.display();
					})
			);

		const cycles = this.plugin.index.cycles();
		if (cycles.length > 0) {
			// Not an error dialog, and not silence: a loop is a typo in the user's own vault, it
			// disables propagation for the questions inside it, and it is invisible unless we say so.
			const warning = this.containerEl.createDiv({ cls: "standing-questions-cycle-warning" });
			warning.createSpan({
				text: `${cycles.length} parent loop${cycles.length === 1 ? "" : "s"} found. Statuses inside a loop are left exactly as you wrote them.`,
			});
			for (const cycle of cycles) {
				warning.createDiv({
					cls: "standing-questions-cycle-members",
					text: cycle.join(" → ") + " → …",
				});
			}
		}
	}

	// --- Leads ---------------------------------------------------------------------

	private renderLeads(): void {
		new Setting(this.containerEl).setName("Leads").setHeading();

		new Setting(this.containerEl)
			.setName("Keyword and link leads")
			.setDesc(
				"Free, and works on every device. Matches a new note against your open questions on shared significant words and on links they have in common."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.keywordLeadsEnabled).onChange(async (value) => {
					this.plugin.settings.keywordLeadsEnabled = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(this.containerEl)
			.setName("Minimum note length")
			.setDesc("Notes shorter than this are not considered. A stub does not answer anything.")
			.addSlider((slider) =>
				slider
					.setLimits(100, 3000, 50)
					.setValue(this.plugin.settings.minLeadChars)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.minLeadChars = value;
						this.plugin.queueSave();
					})
			);

		new Setting(this.containerEl)
			.setName("Most leads per note")
			.setDesc("The cap on how many questions one edited note can be matched against at once.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.maxLeads)
					.setDynamicTooltip()
					.onChange((value) => {
						this.plugin.settings.maxLeads = value;
						this.plugin.queueSave();
					})
			);
	}

	// --- Pro ------------------------------------------------------------------------

	private renderPro(): void {
		const heading = new Setting(this.containerEl).setName("Pro features").setHeading();
		this.markPro(heading);

		this.proRow(
			FEATURES.semanticLeads.label,
			"Matches a note you just wrote against every open question BY MEANING, not by keyword — the note that answers \"Why did we drop CRDTs?\" without ever using the word. Needs the semantic engine.",
			(setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.semanticLeadsEnabled).onChange(async (value) => {
						this.plugin.settings.semanticLeadsEnabled = value;
						await this.plugin.saveSettings();
					})
				);
			}
		);

		this.proRow(
			"Lead threshold",
			"Cosine similarity a passage must reach before you are told about it. 0.75 is conservative on purpose: below about 0.6, notes that merely share a subject start matching, and an add-on that interrupts you with those gets muted within a day. Lower it if you would rather see more.",
			(setting) => {
				setting.addSlider((slider) =>
					slider
						.setLimits(0.5, 0.95, 0.01)
						.setValue(this.plugin.settings.leadMinScore)
						.setDynamicTooltip()
						.onChange((value) => {
							this.plugin.settings.leadMinScore = value;
							// Keep the auto-append bar at or above the notify bar. A lead that is too weak to
							// mention must never be strong enough to write into a note unasked.
							if (this.plugin.settings.leadAutoAppendScore < value) {
								this.plugin.settings.leadAutoAppendScore = value;
							}
							this.plugin.queueSave();
						})
				);
			}
		);

		this.proRow(
			"Write strong leads into the question",
			"Off by default. Leads are NOTIFY-ONLY: nothing is written into any note unless you click \"Add lead\". Turn this on and a lead above the bar below is appended under \"## Leads\" in the question without asking.",
			(setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.leadAutoAppend).onChange(async (value) => {
						this.plugin.settings.leadAutoAppend = value;
						await this.plugin.saveSettings();
						this.display();
					})
				);
			}
		);

		if (this.plugin.settings.isPro && this.plugin.settings.leadAutoAppend) {
			this.proRow(
				"Auto-append threshold",
				"Only leads at or above this are written without asking. Never below the lead threshold.",
				(setting) => {
					setting.addSlider((slider) =>
						slider
							.setLimits(0.5, 0.99, 0.01)
							.setValue(this.plugin.settings.leadAutoAppendScore)
							.setDynamicTooltip()
							.onChange((value) => {
								this.plugin.settings.leadAutoAppendScore = Math.max(
									value,
									this.plugin.settings.leadMinScore
								);
								this.plugin.queueSave();
							})
					);
				}
			);
		}
	}

	// --- Semantic engine (DESIGN 7.2) -------------------------------------------

	private renderEngine(): void {
		new Setting(this.containerEl).setName("Semantic engine").setHeading();

		const host = this.plugin.engine;
		const box = this.containerEl.createDiv({ cls: "standing-questions-engine" });

		if (!host || !host.desktop) {
			box.createEl("p", {
				text: "The semantic engine runs on desktop only. Everything else in this add-on — questions, statuses, sub-questions, the board, and keyword leads — works here.",
			});
			return;
		}

		box.createEl("p", {
			text:
				"Semantic lead detection needs a local engine — a self-contained program that runs on your " +
				`computer and never sends anything over the network. It is ${DOWNLOAD_SIZE_LABEL}, and it is ` +
				"installed outside your vault, in your system's application-data folder.",
		});

		this.progressEl = box.createDiv({ cls: "standing-questions-engine-progress" });

		const status = this.plugin.engineStatus;
		const installed = status?.installed ?? null;
		const byo = status?.byoPath ?? false;
		const plan = host.plan();

		if (installed || byo) {
			this.renderInstalledEngine(box, byo);
		} else {
			this.renderDownloadRow(box, plan !== null);
		}

		// The fallback path, and the honest answer to "is the download the mechanism?". It is not:
		// it is a convenience, and this setting is what makes that true. It is also the fix for
		// every Defender quarantine, noexec mount, Flatpak confinement and hostile Gatekeeper.
		new Setting(box)
			.setName("Path to an existing engine")
			.setDesc(
				"Absolute path to an engine binary you already have. When this is set, nothing is ever downloaded."
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/embed-sidecar")
					.setValue(this.plugin.settings.enginePath)
					.onChange((value) => {
						this.plugin.settings.enginePath = value.trim();
						this.plugin.queueSave();
					})
			);

		new Setting(box)
			.setName("Test engine")
			.setDesc("Starts the engine and asks it for its version. Nothing is downloaded.")
			.addButton((button) =>
				button.setButtonText("Test engine").onClick(async () => {
					button.setDisabled(true);
					try {
						const result = await this.plugin.testEngine();
						new Notice(
							result.health
								? `Engine ready — ${result.health.model}, ${String(result.health.dim)}-dim.`
								: `Engine ${result.state}. ${result.error ?? "No engine is installed."}`
						);
					} finally {
						button.setDisabled(false);
						this.display();
					}
				})
			);

		new Setting(box)
			.setName("Engine log")
			.setDesc("The last 200 lines the engine wrote to its error stream.")
			.addButton((button) =>
				button.setButtonText("Engine log").onClick(() => {
					new EngineLogModal(this.app, host.engineLog()).open();
				})
			);
	}

	/** "Not installed": one button, and it opens the consent modal. It does NOT download. */
	private renderDownloadRow(box: HTMLElement, pinned: boolean): void {
		const host = this.plugin.engine;
		const planError = host?.planError() ?? null;

		const setting = new Setting(box)
			.setName("Download engine")
			.setDesc(
				pinned && ENGINE_RELEASE_PINNED
					? `Downloads engine ${ENGINE_VERSION}, verifies its SHA-256, and runs it. You will be shown the exact URL, version, checksum, and install path before anything is downloaded.`
					: (planError ??
							"No engine build is published for this release yet. Semantic leads stay off until one is; everything else in this add-on works now.")
			);

		setting.addButton((button) => {
			button.setButtonText("Download engine").setCta();
			// A build whose checksum is still the unpinned placeholder REFUSES to download — there
			// would be nothing to verify the bytes against, and downloading an unverified executable
			// is the single thing this whole design exists to prevent. An enabled button that always
			// fails would be worse than the truth.
			if (!pinned || !ENGINE_RELEASE_PINNED || this.installing) {
				button.setDisabled(true);
				if (!ENGINE_RELEASE_PINNED) button.setTooltip("Not available in this release.");
				return;
			}
			button.onClick(() => this.openInstallModal());
		});
	}

	/** "Installed": what is there, and everything you can do to it — including remove it. */
	private renderInstalledEngine(box: HTMLElement, byo: boolean): void {
		const status = this.plugin.engineStatus;
		const installed = status?.installed ?? null;

		const info = new Setting(box).setName("Installed engine");
		if (byo) {
			info.setDesc(
				`Using the engine you pointed at: ${this.plugin.settings.enginePath}. Nothing was downloaded, and nothing will be.`
			);
		} else if (installed) {
			info.setDesc(
				`Version ${installed.version} · ${installed.target} · installed at ${installed.exePath}`
			);
		}

		if (status?.updateAvailable && !byo) {
			// NEVER a silent update. Obsidian policy bans "a mechanism that updates the plugin", and a
			// binary that re-downloads itself is arguably exactly that. We detect, and we offer.
			new Setting(box)
				.setName("Update engine")
				.setDesc(
					`This add-on expects engine ${ENGINE_VERSION}; ${installed?.version ?? "an older version"} is installed. Nothing updates on its own — you will see the URL, checksum and path first.`
				)
				.addButton((button) =>
					button
						.setButtonText("Update engine")
						.setCta()
						.setDisabled(!ENGINE_RELEASE_PINNED || this.installing)
						.onClick(() => this.openInstallModal())
				);
		}

		new Setting(box)
			.setName("Rebuild the question index")
			.setDesc("Re-embeds every question note. Use this after changing what counts as a question.")
			.addButton((button) =>
				button.setButtonText("Rebuild index").onClick(async () => {
					button.setDisabled(true);
					try {
						const count = await this.plugin.rebuildEngineIndex();
						new Notice(`Indexed ${String(count)} question${count === 1 ? "" : "s"}.`);
					} catch (error) {
						new Notice(error instanceof Error ? error.message : "Could not rebuild the index.");
					} finally {
						button.setDisabled(false);
					}
				})
			);

		new Setting(box)
			.setName("Remove engine")
			.setDesc("Stops the engine and deletes the program. Your notes and the index are kept.")
			.addButton((button) =>
				button
					.setButtonText("Remove engine")
					.setWarning()
					.setDisabled(byo)
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.removeEngine();
							new Notice("The engine was removed. The index was kept.");
						} catch (error) {
							new Notice(error instanceof Error ? error.message : "Could not remove the engine.");
						} finally {
							this.display();
						}
					})
			);
	}

	/**
	 * THE CONSENT GATE. `EngineHost.install()` has exactly one caller, and it is the confirm
	 * handler of this modal. Nothing is fetched, unpacked, made executable or run until the user
	 * has seen the URL, the version, the SHA-256, and the directory it lands in.
	 */
	private openInstallModal(): void {
		const host = this.plugin.engine;
		if (!host) return;

		const plan = host.plan();
		if (!plan) {
			new Notice(host.planError() ?? "No engine build is available for this computer.");
			return;
		}

		const info = nodeHostInfo();
		if (!info) {
			new Notice("The semantic engine runs on desktop only.");
			return;
		}

		new EngineInstallModal(this.app, {
			plan,
			installDir: engineInstallDir(info, plan.version),
			downloadSizeLabel: DOWNLOAD_SIZE_LABEL,
			onConfirm: () => {
				void this.runInstall();
			},
		}).open();
	}

	private async runInstall(): Promise<void> {
		const host = this.plugin.engine;
		if (!host || this.installing) return;

		this.installing = true;
		const notice = new Notice("Downloading engine…", 0);
		try {
			const health = await host.install((progress) => {
				const line = describeProgress(progress);
				notice.setMessage(line);
				if (this.progressEl) this.progressEl.setText(line);
			});
			notice.hide();
			new Notice(`Engine ready — ${health.model}, ${String(health.dim)}-dim.`);
			await this.plugin.onEngineInstalled();
		} catch (error) {
			notice.hide();
			// The message is already the specific one: a failed checksum, a blocked exec bit, a
			// quarantined binary. Surface it verbatim — a generic "install failed" is what turns a
			// solvable Defender problem into a one-star review.
			new Notice(error instanceof Error ? error.message : "The engine could not be installed.", 12_000);
		} finally {
			this.installing = false;
			this.display();
		}
	}

	// --- Feedback ----------------------------------------------------------------

	private renderFeedback(): void {
		new Setting(this.containerEl).setName("Feedback").setHeading();

		new Setting(this.containerEl)
			.setName("Bugs and feature requests")
			.setDesc("Issues and ideas are tracked on GitHub. Opens in your browser.")
			.addButton((button) =>
				button.setButtonText("Report a bug").onClick(() => {
					window.open("https://github.com/israerusan/standing-questions/issues/new?labels=bug");
				})
			)
			.addButton((button) =>
				button.setButtonText("Request a feature").onClick(() => {
					window.open("https://github.com/israerusan/standing-questions/issues/new?labels=enhancement");
				})
			);
	}
}

/** `Downloading engine… 18.4 MB / 44.7 MB` (DESIGN 7.2). */
function describeProgress(progress: InstallProgress): string {
	switch (progress.phase) {
		case "downloading": {
			const done = mb(progress.done ?? 0);
			const total = progress.total ? ` / ${mb(progress.total)}` : "";
			return `Downloading engine… ${done}${total}`;
		}
		case "verifying":
			return "Verifying the checksum…";
		case "extracting":
			return "Extracting…";
		case "starting":
			return "Starting…";
		case "ready":
			return progress.message ?? "Engine ready.";
		default:
			return "Working…";
	}
}

function mb(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
