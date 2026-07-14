import { Notice, Plugin, TFile, normalizePath, type WorkspaceLeaf } from "obsidian";
import { resolveLicenseTransition } from "./shared/licenseTransition.mjs";
import { EngineBroker } from "./shared/engine/EngineBroker";
import type { EngineHost, EngineStatus } from "./shared/engine/EngineHost";
import { LicenseManager } from "./license/LicenseManager";
import {
	DEFAULT_SETTINGS,
	INDEX_DEBOUNCE_MS,
	PROPAGATE_DEBOUNCE_MS,
	SAVE_DEBOUNCE_MS,
	type StandingQuestionsSettings,
} from "./settings";
import { QuestionIndex, isExcluded } from "./questionIndex";
import { QuestionEngineIndex } from "./engineIndex";
import { LeadPipeline } from "./leadPipeline";
import { QuestionBoardView, VIEW_TYPE_QUESTION_BOARD } from "./ui/QuestionBoardView";
import { StandingQuestionsSettingTab } from "./ui/SettingsTab";
import { noticePropagated, registerCommands } from "./commands";
import type { QuestionStatus } from "./core/questionParse.mjs";

export default class StandingQuestionsPlugin extends Plugin {
	settings: StandingQuestionsSettings = { ...DEFAULT_SETTINGS };
	/** The last verification failure, for the License section. Not persisted. */
	licenseError: string | undefined;

	index!: QuestionIndex;
	engineIndex!: QuestionEngineIndex;
	leads!: LeadPipeline;

	/** Null on mobile, on an unsupported platform, or when an incompatible engine client is loaded. */
	engine: EngineHost | null = null;
	/** Cached: reading the install state touches the disk, and checkCallback cannot await. */
	engineStatus: EngineStatus | null = null;
	private engineReady = false;

	private saveTimer: number | null = null;
	private indexTimer: number | null = null;
	private propagateTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.refreshLicense();

		this.index = new QuestionIndex(this.app, this.settings);

		// Constructing a host SPAWNS NOTHING and DOWNLOADS NOTHING — the child starts lazily on the
		// first request, and a download happens only from EngineInstallModal's confirm handler. This
		// call exists to put this add-on into the shared refcount, which is what guarantees the one
		// engine process is killed exactly when the last Second Read add-on unloads, and not before
		// (Prior Art may be talking to the same one).
		this.engine = EngineBroker.acquire(this.app, this.manifest.id, {
			enginePath: this.settings.enginePath || undefined,
		});

		this.engineIndex = new QuestionEngineIndex(this.app, () => this.engine);
		this.leads = new LeadPipeline({
			app: this.app,
			settings: this.settings,
			index: this.index,
			engineIndex: this.engineIndex,
			canUseSemanticPro: () => this.canUseSemanticPro(),
		});

		this.registerView(
			VIEW_TYPE_QUESTION_BOARD,
			(leaf: WorkspaceLeaf) => new QuestionBoardView(leaf, this)
		);

		registerCommands(this);
		this.addSettingTab(new StandingQuestionsSettingTab(this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				// A question changing is index work. Any OTHER note changing is a possible answer, and
				// that is the debounced pipeline — 2.5 s per path, never per keystroke.
				this.scheduleIndex();
				this.leads.schedule(file.path);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;
				this.leads.forget(file.path);
				void this.engineIndex.remove([file.path]);
				this.scheduleIndex();
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				this.leads.forget(oldPath);
				void this.engineIndex.rename(oldPath, file.path);
				this.scheduleIndex();
			})
		);

		// `resolved` fires when metadataCache has finished a pass — which is when frontmatter AND
		// resolvedLinks are actually trustworthy. Building the DAG off `changed` alone reads a
		// half-resolved link graph and produces phantom dangling parents.
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleIndex()));

		// The first real work, deferred so a cold start does not fight the vault's own indexing pass.
		this.app.workspace.onLayoutReady(() => {
			void this.reindex();
			void this.refreshEngineStatus();
		});
	}

	onunload(): void {
		this.clearTimer(this.saveTimer);
		this.saveTimer = null;
		this.clearTimer(this.indexTimer);
		this.indexTimer = null;
		this.clearTimer(this.propagateTimer);
		this.propagateTimer = null;

		this.leads?.dispose();

		// Drops this add-on's ref. When the LAST Second Read add-on releases, the engine child
		// process is killed — and not one moment before, because Prior Art may be mid-query against
		// the same process. This is the kill path that makes a zombie sidecar impossible; the other
		// two (stdin EOF, the --parent-pid watchdog) survive an Obsidian crash.
		EngineBroker.release(this.manifest.id);

		// Deliberately NOT detachLeavesOfType(): the obsidianmd `detach-leaves` rule forbids it, and
		// closing the user's sidebar on an update is rude.
	}

	// --- settings -------------------------------------------------------------

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = (loaded ?? {}) as Record<string, unknown>;
		// A hostile or corrupt data.json must not reach the prototype chain and forge `isPro` onto
		// every object in the runtime.
		if (Object.prototype.hasOwnProperty.call(data, "__proto__")) delete data["__proto__"];

		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.excludeFolders = coerceStringArray(this.settings.excludeFolders);
		this.settings.isPro = this.settings.isPro === true;
		this.settings.leadMinScore = clamp(this.settings.leadMinScore, 0.1, 0.99, DEFAULT_SETTINGS.leadMinScore);
		this.settings.leadAutoAppendScore = Math.max(
			clamp(this.settings.leadAutoAppendScore, 0.1, 0.99, DEFAULT_SETTINGS.leadAutoAppendScore),
			this.settings.leadMinScore
		);
	}

	async saveSettings(): Promise<void> {
		this.clearTimer(this.saveTimer);
		this.saveTimer = null;
		await this.saveData(this.settings);
		this.index.updateSettings(this.settings);
		this.engine?.updateSettings({ enginePath: this.settings.enginePath || undefined });
		this.scheduleIndex();
	}

	/** Coalesced save, for controls that fire continuously (sliders, the license textarea). */
	queueSave(): void {
		this.clearTimer(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveSettings();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Flush a queued save immediately — the settings tab calls this when it closes. */
	async flushPendingSave(): Promise<void> {
		if (this.saveTimer === null) return;
		await this.saveSettings();
	}

	/**
	 * Re-verify the stored key and apply the resulting entitlement.
	 *
	 * @param persistUnchanged save even when nothing moved (so a key being typed survives a restart)
	 * @param coalesce queue the save instead of writing immediately
	 * @returns true when Pro actually FLIPPED — the caller re-renders on that, and only that
	 */
	async refreshLicense(persistUnchanged = false, coalesce = false): Promise<boolean> {
		const key = this.settings.licenseKey.trim();
		const result = key ? LicenseManager.verify(key) : null;
		const next = resolveLicenseTransition(
			{ isPro: this.settings.isPro, email: this.settings.licenseEmail },
			key,
			result,
			persistUnchanged
		);

		this.settings.isPro = next.isPro;
		this.settings.licenseEmail = next.email;
		this.licenseError = key && !next.isPro ? (result?.error ?? "Invalid license key.") : undefined;
		this.settings.licenseStatus = next.isPro ? "valid-pro" : key ? "invalid" : "free";

		if (next.flipped) this.onEntitlementChanged();
		if (next.persist) {
			if (coalesce && !next.flipped) this.queueSave();
			else await this.saveSettings();
		}
		return next.flipped;
	}

	/**
	 * Pro flipped. Disable the Pro-only persisted setting when it flips OFF (an expired key must
	 * not leave a Pro toggle silently "on" and doing nothing), and repaint.
	 */
	private onEntitlementChanged(): void {
		if (!this.settings.isPro) this.settings.semanticLeadsEnabled = DEFAULT_SETTINGS.semanticLeadsEnabled;
		this.renderBoards();
	}

	// --- the index ------------------------------------------------------------

	private scheduleIndex(): void {
		this.clearTimer(this.indexTimer);
		this.indexTimer = window.setTimeout(() => {
			this.indexTimer = null;
			void this.reindex();
		}, INDEX_DEBOUNCE_MS);
	}

	private async reindex(): Promise<void> {
		await this.index.rebuild();
		this.renderBoards();

		if (this.settings.autoPropagate) this.schedulePropagate();

		// Keeping the ENGINE's copy of the questions current is Pro + engine work, and it is the
		// only thing in this method that can touch a subprocess. A free user, a mobile user, and a
		// Pro user with no engine installed all stop here — with a fully working add-on.
		if (this.canUseSemanticPro() && this.settings.semanticLeadsEnabled) {
			void this.engineIndex.sync(this.index.all());
		}
	}

	private renderBoards(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QUESTION_BOARD)) {
			const view = leaf.view;
			if (view instanceof QuestionBoardView) view.render();
		}
	}

	private schedulePropagate(): void {
		this.clearTimer(this.propagateTimer);
		this.propagateTimer = window.setTimeout(() => {
			this.propagateTimer = null;
			void this.propagateStatuses();
		}, PROPAGATE_DEBOUNCE_MS);
	}

	/**
	 * Write every propagated status back into its note.
	 *
	 * Only where the computed status DIFFERS from what is written — `processFrontMatter` is a
	 * vault write, and writing a value that is already there would churn the mtime of every
	 * question note on every metadata pass. (Which would, among other things, make Note Decay
	 * think the whole vault had just been edited.)
	 *
	 * Questions inside a `parent::` loop are never touched: `pendingChanges()` excludes them,
	 * because propagateStatus leaves a cycle member's status exactly as the user wrote it.
	 */
	async propagateStatuses(announce = false): Promise<number> {
		const changes = this.index.pendingChanges();
		let written = 0;
		for (const change of changes) {
			const file = this.app.vault.getFileByPath(change.id);
			if (!(file instanceof TFile)) continue;
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[this.settings.statusKey] = change.to;
			});
			written++;
		}
		if (written > 0) await this.index.rebuild();
		if (announce) noticePropagated(written);
		this.renderBoards();
		return written;
	}

	// --- actions --------------------------------------------------------------

	async activateBoard(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUESTION_BOARD)[0];
		const leaf: WorkspaceLeaf | null = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_QUESTION_BOARD, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	async openNote(path: string, event?: MouseEvent): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		const newTab = Boolean(event?.ctrlKey || event?.metaKey);
		await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
	}

	async setStatus(file: TFile, status: QuestionStatus): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter[this.settings.statusKey] = status;
		});
		await this.reindex();
		new Notice(`"${file.basename}" is ${status}.`);
	}

	/** A question note is frontmatter and a title. The title IS the question. */
	async createQuestion(title: string, parent: string): Promise<void> {
		const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
		if (safe === "") {
			new Notice("That title cannot be used as a file name.");
			return;
		}
		const path = normalizePath(`${safe}.md`);
		if (this.app.vault.getFileByPath(path)) {
			new Notice("A note with that name already exists.");
			return;
		}

		const lines = [
			"---",
			`${this.settings.typeKey}: ${this.settings.questionValue}`,
			`${this.settings.statusKey}: open`,
		];
		if (parent) lines.push(`${this.settings.parentKey}: "[[${parent}]]"`);
		lines.push("---", "", `# ${title}`, "");

		const file = await this.app.vault.create(path, lines.join("\n"));
		await this.app.workspace.getLeaf(false).openFile(file);
		await this.reindex();
	}

	/** The "Find leads for open questions" command. Works free (keyword) and Pro (semantic). */
	async findLeads(file: TFile): Promise<void> {
		if (isExcluded(file.path, this.settings.excludeFolders)) {
			new Notice("This note is in an excluded folder.");
			return;
		}
		await this.leads.run(file.path, true);
	}

	// --- the engine -----------------------------------------------------------

	/**
	 * True when semantic leads can actually run: Pro AND a desktop engine AND one that is
	 * installed. Three separate conditions, kept separate on purpose — a mobile Pro user is not
	 * being paywalled, and telling them they are would be a lie.
	 */
	canUseSemanticPro(): boolean {
		return this.settings.isPro && this.engine !== null && this.engineReady;
	}

	async refreshEngineStatus(): Promise<EngineStatus | null> {
		if (!this.engine) {
			this.engineReady = false;
			this.engineStatus = null;
			return null;
		}
		const status = await this.engine.status();
		this.engineStatus = status;
		this.engineReady = status.state === "installed" || status.state === "running";
		return status;
	}

	/** The settings "Test engine" button. Starts what is installed; downloads nothing. */
	async testEngine(): Promise<EngineStatus> {
		if (!this.engine) {
			return {
				state: "unsupported",
				expectedVersion: "",
				installed: null,
				updateAvailable: false,
				byoPath: false,
				health: null,
				error: "The semantic engine runs on desktop only.",
			};
		}
		try {
			await this.engine.ensureStarted();
		} catch (error) {
			console.error("standing-questions: the engine probe failed", error);
		}
		const status = await this.refreshEngineStatus();
		return status ?? (await this.engine.status());
	}

	/** After a successful install: pick up the new state and fill the question index. */
	async onEngineInstalled(): Promise<void> {
		this.engineIndex.reset();
		await this.refreshEngineStatus();
		if (this.canUseSemanticPro()) await this.engineIndex.sync(this.index.all());
	}

	async rebuildEngineIndex(): Promise<number> {
		if (!this.canUseSemanticPro()) {
			throw new Error("The semantic engine is not available. Nothing to rebuild.");
		}
		return this.engineIndex.rebuild(this.index.all());
	}

	/**
	 * Remove the engine binary. The index is deliberately kept (DESIGN 7.3 step 9).
	 *
	 * The release/re-acquire dance is a WORKAROUND, not a flourish. The vendored
	 * `EngineHost.remove()` calls `dispose()`, which latches an internal `disposed` flag for the
	 * lifetime of the object — so the shared host is permanently poisoned, and a user who removed
	 * the engine and then clicked "Download engine" in the same session would hit "the engine host
	 * was unloaded" during the health handshake. Dropping our ref (which kills and clears the
	 * global when we are the last engine add-on) and re-acquiring hands us a FRESH host, so the
	 * remove-then-reinstall path works without a restart.
	 *
	 * The correct fix is one character in obsidian-plugin-core — `remove()` should call
	 * `dispose(true)` — and it is reported upstream rather than patched here, because the vendored
	 * tree is byte-checked and must never be edited inside a plugin repo.
	 */
	async removeEngine(): Promise<void> {
		if (!this.engine) return;
		const shared = EngineBroker.refs().filter((id) => id !== this.manifest.id);

		await this.engine.remove();
		this.engineIndex.reset();

		EngineBroker.release(this.manifest.id);
		this.engine = EngineBroker.acquire(this.app, this.manifest.id, {
			enginePath: this.settings.enginePath || undefined,
		});
		await this.refreshEngineStatus();

		if (shared.length > 0) {
			new Notice(
				"Other Second Read add-ons were using this engine. Reload Obsidian so they notice it is gone.",
				10_000
			);
		}
	}

	// --- internals ------------------------------------------------------------

	private clearTimer(timer: number | null): void {
		if (timer !== null) window.clearTimeout(timer);
	}
}

function coerceStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const num = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, num));
}
