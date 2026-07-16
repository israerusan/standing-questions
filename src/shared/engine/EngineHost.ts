/**
 * EngineHost — download, verify, extract, spawn, and talk to the Second Read
 * semantic engine.
 *
 * Obsidian-coupled (Platform, App, FileSystemAdapter) and therefore NOT unit
 * tested here: every decision it makes that CAN be pure has been pushed into
 * protocol.mjs (framing/routing/deadlines) and installPlan.mjs (target, URL,
 * checksum, redirect allowlist), which are tested. What is left is the shell.
 *
 * The five rules this file exists to enforce (DESIGN 6.1, 6.6, 7.3):
 *
 *  1. NO STATIC NODE IMPORTS. `child_process`/`fs`/`https`/`os`/`path`/`crypto`
 *     are obtained through `window.require` inside a `Platform.isDesktop` guard.
 *     A static `import "fs"` compiles to a TOP-LEVEL `require()` in the CJS
 *     bundle and crashes every mobile user on load, manifest flag or not.
 *  2. NO `fetch` (the review bot flags it) and NO `requestUrl` (it cannot stream
 *     or report progress). Node `https.get` + `fs.createWriteStream`, which also
 *     means the file is written WITHOUT `com.apple.quarantine` / Mark-of-the-Web,
 *     which is the only reason Gatekeeper and SmartScreen stay out of the way.
 *  3. THE SHA-256 IS VERIFIED BEFORE THE EXEC BIT IS SET. Fail closed: on any
 *     mismatch the file is deleted and nothing is extracted, chmod-ed or run.
 *     A build whose pinned checksum is still the placeholder refuses to download
 *     at all (UnpinnedReleaseError).
 *  4. NOTHING IS EVER AUTO-UPDATED. `updateAvailable` is surfaced; the user
 *     clicks. Obsidian policy bans "a mechanism that updates the plugin".
 *  5. NOTHING IS DOWNLOADED WITHOUT CONSENT. `install()` is only ever called from
 *     EngineInstallModal's confirm handler.
 *
 * The BYO escape hatch (`settings.enginePath`) skips the download entirely. It is
 * the fix for Defender quarantine, `noexec` mounts, Flatpak confinement and a
 * hostile Gatekeeper, and it is the honest answer to a reviewer asking whether the
 * download is the mechanism or a convenience.
 */
import { FileSystemAdapter, Platform, type App } from "obsidian";
import { unzipSync } from "fflate";
import { fnv1a64 } from "../hash.mjs";
import {
	ERROR_CODES,
	EngineRpcError,
	FrameDecoder,
	PendingRequests,
	encodeRequest,
	timeoutFor,
	type EngineWireError,
} from "./protocol.mjs";
import {
	UnsupportedPlatformError,
	isAllowedDownloadUrl,
	planForHost,
	type InstallPlan,
} from "./installPlan.mjs";
import { ENGINE_DIM, ENGINE_MODEL, ENGINE_VERSION } from "./engineRelease.mjs";

/* ------------------------------------------------------------------ types -- */

export interface EngineSettings {
	/**
	 * Absolute path to an engine binary the user already has. When set, the plugin
	 * NEVER downloads: it feature-detects this binary with a `health` probe and
	 * spawns it. This is the review fallback and the support answer for every
	 * platform that refuses to run a downloaded executable.
	 */
	enginePath?: string;
}

export interface EngineHealth {
	ok: boolean;
	version: string;
	/** "onnx" | "potion". A potion vector and a MiniLM vector are NOT comparable — a change here means reindex. */
	engine: string;
	model: string;
	dim: number;
	pid: number;
	vault: string | null;
	chunks: number;
}

export interface InstalledInfo {
	version: string;
	target: string;
	/**
	 * The digest of the ARCHIVE that was downloaded and verified. It is a receipt, not a
	 * guard: the zip is deleted the moment it is extracted, so nothing on disk can ever be
	 * re-checked against it. Do not reach for this to decide whether it is safe to execute
	 * something — that is what `exeSha256` is for.
	 */
	sha256: string;
	/**
	 * The digest of the EXECUTABLE ITSELF, taken from the extracted file at install time.
	 * `resolveExecutable()` re-computes it and refuses to spawn on a mismatch, which is the
	 * only thing standing between "anything that can write %LOCALAPPDATA% (a dropper, a sync
	 * client, another installer) swapped the binary" and "the next click on Test engine ran
	 * it". Absent on records written by builds before this field existed — those fail closed.
	 */
	exeSha256: string;
	installedAt: number;
	exePath: string;
}

export type EngineState =
	| "unsupported" // mobile, or a platform we ship no build for
	| "not-installed"
	| "installed"
	| "starting"
	| "running"
	| "error";

export interface EngineStatus {
	state: EngineState;
	/** The version this build of the plugin expects. */
	expectedVersion: string;
	installed: InstalledInfo | null;
	/** True when an engine is installed but is not the version this build expects. NEVER acted on automatically. */
	updateAvailable: boolean;
	/** True when settings.enginePath is in use and the download flow is bypassed entirely. */
	byoPath: boolean;
	health: EngineHealth | null;
	error?: string;
}

export type InstallPhase = "downloading" | "verifying" | "extracting" | "starting" | "ready";

export interface InstallProgress {
	phase: InstallPhase;
	/** Bytes received, for `downloading`. */
	done?: number;
	/** Content-Length, for `downloading`. 0 when the server did not send one. */
	total?: number;
	message?: string;
}

/** Server->client `progress` notification (DESIGN 6.1). */
export interface EngineProgress {
	for: number;
	done: number;
	total: number;
}

export interface RequestOptions {
	timeoutMs?: number;
	onProgress?: (p: EngineProgress) => void;
	/**
	 * The request's JSON-RPC id, handed back SYNCHRONOUSLY before the frame is written to
	 * stdin. Without this the caller never learns the id, and the `cancel` RPC (DESIGN 6.2,
	 * method 8) can never be sent — so every superseded keystroke leaves the engine embedding
	 * a query whose answer will be thrown away, which is most of them.
	 */
	onRequestId?: (id: number) => void;
}

/* ------------------------------------------------------ Node, lazily typed -- */

// `window.require` hands back `unknown`; loadNode() narrows each module to its real
// type-only shape below. Nothing here is a static `import "fs"` — the requires are lazy
// and desktop-guarded — so `isDesktopOnly: false` and the mobile free tier are unaffected.
type NodeRequire = (id: string) => unknown;

interface NodeApi {
	cp: typeof import("child_process");
	fs: typeof import("fs");
	https: typeof import("https");
	os: typeof import("os");
	path: typeof import("path");
	crypto: typeof import("crypto");
	proc: typeof import("process");
}

/** ~45 MB over a bad hotel connection is still under this. */
const DOWNLOAD_STALL_MS = 60_000;
const MAX_REDIRECTS = 5;
/**
 * A hard ceiling on the download, and a second ceiling at 4x whatever Content-Length the
 * server claimed. The SHA-256 is only checked once the bytes have LANDED, so without a cap an
 * allowlisted-but-compromised host (or a GitHub account takeover) can stream unbounded bytes
 * into the user's %LOCALAPPDATA% before we ever get to reject them. The engine zip is ~45 MB.
 */
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 15_000;
const STDERR_RING_LINES = 200;
const IDLE_EXIT_SECONDS = 600;
const WIN_KILL_GRACE_MS = 2_000;
const SWEEP_INTERVAL_MS = 1_000;

/** Suite-wide app-data directory name (DESIGN 7.1). NEVER inside the vault. */
const ENGINE_HOME_DIR = "second-read-engine";

/**
 * `window.require`, or null on mobile / in a hardened renderer. Every Node access in
 * this file goes through here, and every caller must handle null by degrading — that
 * is what lets all five plugins ship `isDesktopOnly: false` with a working free tier.
 */
function loadNode(): NodeApi | null {
	if (!Platform.isDesktop) return null;
	try {
		const req = (window as unknown as { require?: NodeRequire }).require;
		if (typeof req !== "function") return null;
		return {
			cp: req("child_process") as typeof import("child_process"),
			fs: req("fs") as typeof import("fs"),
			https: req("https") as typeof import("https"),
			os: req("os") as typeof import("os"),
			path: req("path") as typeof import("path"),
			crypto: req("crypto") as typeof import("crypto"),
			proc: req("process") as typeof import("process"),
		};
	} catch {
		return null;
	}
}

/** `<LOCALAPPDATA|Application Support|XDG_DATA_HOME>/second-read-engine` (DESIGN 7.1). */
function engineHome(node: NodeApi): string {
	const { os, path, proc } = node;
	const platform: string = os.platform();
	const home: string = os.homedir();
	if (platform === "win32") {
		const local: string = proc.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
		return path.join(local, ENGINE_HOME_DIR);
	}
	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", ENGINE_HOME_DIR);
	}
	const xdg: string = proc.env.XDG_DATA_HOME || path.join(home, ".local", "share");
	return path.join(xdg, ENGINE_HOME_DIR);
}

/**
 * Reject any zip entry that would land outside the destination — the zip-slip check
 * (DESIGN 7.3 step 5). fflate carries no unix mode bits, so a symlink entry
 * materializes as an ordinary file whose contents are the link target: it cannot
 * escape, and this check is the whole defence.
 */
function safeEntryPath(node: NodeApi, destDir: string, entry: string): string | null {
	const { path } = node;
	const rel = entry.replace(/\\/g, "/");
	if (rel.length === 0 || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
	if (rel.split("/").some((seg) => seg === "..")) return null;
	const target = path.resolve(destDir, rel);
	const root = path.resolve(destDir);
	if (target !== root && !target.startsWith(root + path.sep)) return null;
	return target;
}

/** DESIGN 7.3 step 8 — turn an errno into the sentence that actually helps the user. */
function describeSpawnFailure(err: unknown): string {
	const e = err as { code?: string; signal?: string; message?: string } | null;
	const code = e?.code ?? "";
	if (code === "EACCES" || code === "EPERM") {
		return "Your system blocked the engine from running (a read-only or noexec location, or a security policy). Set a path to an existing engine in settings.";
	}
	if (code === "ENOENT") {
		return "The engine executable is missing. Try downloading it again.";
	}
	if (e?.signal === "SIGKILL") {
		return "macOS refused to run the engine (code signature). This is a build problem — please report it.";
	}
	return e?.message ? String(e.message) : "The engine failed to start.";
}

/* ------------------------------------------------------------------- host -- */

interface Settle {
	resolve: (value: unknown) => void;
	reject: (err: EngineRpcError) => void;
	onProgress?: (p: EngineProgress) => void;
}

export class EngineHost {
	private readonly app: App;
	/**
	 * pluginId -> that plugin's engine settings. The host is SHARED by up to five plugins, so
	 * "the engine path" is not one value: each plugin has its own settings tab with its own
	 * "Path to an existing engine" field, and they all point at this one object.
	 *
	 * Keeping only the last-written settings object (what this used to do) broke the BYO path
	 * both ways: a plugin that acquired the host later had its configured path DISCARDED, and
	 * a plugin saving any unrelated setting overwrote the shared settings with its own empty
	 * `enginePath` and WIPED another plugin's. That escape hatch is the documented answer to
	 * Defender quarantine / noexec / Flatpak / Gatekeeper, so it silently doing nothing for
	 * four plugins out of five is not a small bug.
	 *
	 * Resolution is "the first non-empty path, by plugin id". The empty-string key is the
	 * bucket for a caller that did not identify itself; it sorts first, so a path the user
	 * just typed into some settings tab takes effect immediately for every plugin.
	 */
	private readonly settingsByPlugin = new Map<string, EngineSettings>();
	private settings: EngineSettings;
	private readonly node: NodeApi | null;

	private child: import("child_process").ChildProcessWithoutNullStreams | null = null;
	/** The exe we spawned, kept so a kill can verify it is still killing OUR process. */
	private childExePath: string | null = null;
	private decoder = new FrameDecoder();
	private pending = new PendingRequests<Settle>();
	private sweepTimer: number | null = null;

	private startPromise: Promise<EngineHealth> | null = null;
	private lastHealth: EngineHealth | null = null;
	private lastError: string | undefined;
	private state: EngineState = "not-installed";
	private readonly stderrRing: string[] = [];
	private stderrTail = "";
	private disposed = false;

	constructor(app: App, settings: EngineSettings, pluginId = "") {
		this.app = app;
		this.settingsByPlugin.set(pluginId, { ...settings });
		this.settings = {};
		this.resolveSettings();
		this.node = loadNode();
		if (!this.node) this.state = "unsupported";
	}

	/* --------------------------------------------------------- introspection */

	/**
	 * One plugin's engine settings changed (e.g. the user typed a BYO path). Not a restart.
	 *
	 * ALWAYS pass `pluginId`. Omitting it lands the settings in the shared anonymous bucket,
	 * which works — it is how a path typed into any settings tab reaches the other plugins —
	 * but it cannot express "THIS plugin cleared its path", so a clear will not take effect
	 * until the next reload.
	 */
	updateSettings(settings: EngineSettings, pluginId = ""): void {
		this.settingsByPlugin.set(pluginId, { ...settings });
		this.resolveSettings();
	}

	/** A plugin released its ref. Drop its contribution so its BYO path stops applying. */
	forgetPlugin(pluginId: string): void {
		if (!this.settingsByPlugin.delete(pluginId)) return;
		this.resolveSettings();
	}

	/**
	 * Every still-contributing plugin's settings, copied out.
	 *
	 * EngineBroker needs this to seed a REPLACEMENT host when it has to discard a disposed one:
	 * the surviving plugins are still loaded, still have their BYO "Path to an existing engine"
	 * configured, and will never re-send it — they do not know the host was swapped. Without
	 * this the replacement is built from the acquiring plugin's settings alone and every sibling
	 * silently reverts to downloading the engine.
	 */
	pluginSettings(): Map<string, EngineSettings> {
		const copy = new Map<string, EngineSettings>();
		for (const [pluginId, settings] of this.settingsByPlugin) copy.set(pluginId, { ...settings });
		return copy;
	}

	/** First non-empty `enginePath`, by plugin id. The anonymous bucket ("") sorts first. */
	private resolveSettings(): void {
		let enginePath: string | undefined;
		for (const pluginId of [...this.settingsByPlugin.keys()].sort()) {
			const candidate = (this.settingsByPlugin.get(pluginId)?.enginePath ?? "").trim();
			if (candidate) {
				enginePath = candidate;
				break;
			}
		}
		this.settings = { enginePath };
	}

	get desktop(): boolean {
		return this.node !== null;
	}

	isAlive(): boolean {
		return this.child !== null;
	}

	/**
	 * True once this host has been permanently torn down. `dispose()` latches this forever, so
	 * a disposed host rejects EVERY request — including the `health` handshake inside a fresh
	 * `install()`. EngineBroker MUST check it before handing a cached host to a plugin, or one
	 * plugin's "Remove engine" click poisons the engine for every other Second Read add-on in
	 * the realm until Obsidian is restarted.
	 */
	isDisposed(): boolean {
		return this.disposed;
	}

	/** Last 200 stderr lines — the settings "Engine log" disclosure. */
	engineLog(): string[] {
		return [...this.stderrRing];
	}

	/** FNV-1a-64 of the normalized absolute vault path. The sidecar's index key (DESIGN 7.1). */
	vaultKey(): string {
		const adapter = this.app.vault.adapter;
		const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
		return fnv1a64(
			String(base)
				.replace(/\\/g, "/")
				.replace(/\/+$/, "")
				.toLowerCase()
		);
	}

	/** Null on mobile, on an unsupported platform, or when this build has no pinned checksum. */
	plan(): InstallPlan | null {
		if (!this.node) return null;
		try {
			return planForHost(this.node.os.platform(), this.node.os.arch(), ENGINE_VERSION);
		} catch {
			return null;
		}
	}

	/** Why `plan()` returned null, in a sentence the settings tab can print. */
	planError(): string | null {
		if (!this.node) return "The semantic engine runs on desktop only. Everything else in this add-on works here.";
		try {
			planForHost(this.node.os.platform(), this.node.os.arch(), ENGINE_VERSION);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	async status(): Promise<EngineStatus> {
		const byo = Boolean(this.settings.enginePath && this.settings.enginePath.trim());
		const installed = byo ? null : await this.readInstalled();
		let state = this.state;
		if (!this.node) state = "unsupported";
		else if (this.child) state = this.state === "starting" ? "starting" : "running";
		else if (byo || installed) state = this.state === "error" ? "error" : "installed";
		else state = this.state === "error" ? "error" : "not-installed";

		return {
			state,
			expectedVersion: ENGINE_VERSION,
			installed,
			updateAvailable: Boolean(installed && installed.version !== ENGINE_VERSION),
			byoPath: byo,
			health: this.lastHealth,
			error: this.lastError,
		};
	}

	/* -------------------------------------------------------------- install */

	/**
	 * Download, verify, extract, chmod, spawn, health-check.
	 *
	 * PRECONDITION: the user has clicked "Download and run" in EngineInstallModal.
	 * Do not call this from onload(), from a settings-tab render, or from any code
	 * path the user did not initiate. A download at load time with no consent is
	 * exactly the dropper shape the reviewers hardened against.
	 */
	async install(onProgress?: (p: InstallProgress) => void): Promise<EngineHealth> {
		const node = this.requireNode();
		const { fs, path } = node;
		const target = planForHost(node.os.platform(), node.os.arch(), ENGINE_VERSION);
		if (!target) throw new UnsupportedPlatformError(node.os.platform(), node.os.arch());
		const plan = target;

		const home = engineHome(node);
		const binDir: string = path.join(home, "bin", plan.version);
		const tmpZip: string = path.join(home, `${plan.assetName}.part`);

		await fs.promises.mkdir(home, { recursive: true });
		await fs.promises.mkdir(path.dirname(tmpZip), { recursive: true });

		// 1. Download (Node https -> a plain file write: no quarantine bit, no MOTW).
		onProgress?.({ phase: "downloading", done: 0, total: 0 });
		let sha256: string;
		try {
			sha256 = await this.download(node, plan.url, tmpZip, (done, total) =>
				onProgress?.({ phase: "downloading", done, total })
			);
		} catch (err) {
			await this.quietRm(node, tmpZip);
			throw err;
		}

		// 2. Verify BEFORE anything is extracted and BEFORE any exec bit is set.
		onProgress?.({ phase: "verifying" });
		if (sha256 !== plan.sha256) {
			await this.quietRm(node, tmpZip);
			throw new EngineRpcError(
				ERROR_CODES.IO_ERROR,
				"Download failed integrity check — nothing was run."
			);
		}

		// 3. Extract, with a zip-slip guard on every entry.
		onProgress?.({ phase: "extracting" });
		await this.quietRmDir(node, binDir);
		await fs.promises.mkdir(binDir, { recursive: true });
		try {
			await this.extract(node, tmpZip, binDir);
		} finally {
			await this.quietRm(node, tmpZip);
		}

		const exePath = await this.findExecutable(node, binDir, plan.executable);
		if (!exePath) {
			throw new EngineRpcError(
				ERROR_CODES.IO_ERROR,
				`The downloaded archive did not contain ${plan.executable}.`
			);
		}

		// 4. Only now does anything become executable.
		if (node.os.platform() !== "win32") {
			await fs.promises.chmod(exePath, 0o755);
			// Belt and braces; a Node write sets no quarantine bit, so this should be a
			// no-op. Never build the flow around it — stripping quarantine is a scanner
			// heuristic all by itself.
			if (node.os.platform() === "darwin") {
				await new Promise<void>((resolve) => {
					try {
						node.cp.execFile(
							"xattr",
							["-dr", "com.apple.quarantine", binDir],
							{ timeout: 5000 },
							() => resolve()
						);
					} catch {
						resolve();
					}
				});
			}
		}

		// 5. Spawn + handshake.
		onProgress?.({ phase: "starting" });
		const real: string = await fs.promises.realpath(exePath);
		// Taken BEFORE the spawn, from the bytes we just verified and extracted ourselves. This
		// is the value every later start is checked against; the archive digest above cannot do
		// that job, because the archive no longer exists.
		const exeSha256 = await this.hashFile(node, real);
		const health = await this.startAt(node, real);

		const info: InstalledInfo = {
			version: plan.version,
			target: plan.target,
			sha256: plan.sha256,
			exeSha256,
			installedAt: Date.now(),
			exePath: real,
		};
		await fs.promises.writeFile(path.join(home, "installed.json"), JSON.stringify(info, null, 2) + "\n");
		await this.pruneOldVersions(node, home, plan.version);

		onProgress?.({ phase: "ready", message: `Engine ready — ${health.model}, ${health.dim}-dim.` });
		return health;
	}

	/**
	 * Kill the child, delete the binaries, forget the install. The index is deliberately KEPT.
	 *
	 * `dispose(true)` — NOT `dispose()`. This host is SHARED: the plain `dispose()` latches
	 * `disposed = true` for the object's lifetime, and every other Second Read plugin holding
	 * a ref would then get "The engine host was unloaded." from every call, including the
	 * `health` handshake inside a fresh `install()` — so the user could not even re-download
	 * the engine they just removed until they restarted Obsidian. Removing the binary must
	 * leave the host usable and empty, not dead.
	 */
	async remove(): Promise<void> {
		const node = this.requireNode();
		this.dispose(true);
		const home = engineHome(node);
		await this.quietRmDir(node, node.path.join(home, "bin"));
		await this.quietRm(node, node.path.join(home, "installed.json"));
		await this.quietRm(node, this.pidFile(node));
		this.state = "not-installed";
		this.lastHealth = null;
		this.lastError = undefined;
	}

	async readInstalled(): Promise<InstalledInfo | null> {
		if (!this.node) return null;
		try {
			const raw: string = await this.node.fs.promises.readFile(
				this.node.path.join(engineHome(this.node), "installed.json"),
				"utf8"
			);
			const parsed = JSON.parse(raw) as InstalledInfo;
			return parsed && typeof parsed.exePath === "string" ? parsed : null;
		} catch {
			return null;
		}
	}

	/* --------------------------------------------------------------- spawn */

	/**
	 * Start the engine if it is not running. Idempotent and concurrency-safe: five
	 * plugins calling this in the same tick share one promise and one process.
	 *
	 * Returns null rather than throwing when there is simply nothing installed — the
	 * caller renders "Download engine", not an error.
	 */
	async ensureStarted(): Promise<EngineHealth | null> {
		if (this.disposed || !this.node) return null;
		if (this.child && this.lastHealth) return this.lastHealth;
		if (this.startPromise) return this.startPromise;

		const exe = await this.resolveExecutable();
		if (!exe) return null;

		this.startPromise = this.startAt(this.node, exe).finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	/**
	 * BYO path wins over anything downloaded — that is the point of it.
	 *
	 * THE INSTALLED PATH IS RE-VERIFIED ON EVERY START, not just at install. The checksum in
	 * the release manifest guards the download; it does not guard the file for the rest of its
	 * life on disk. `%LOCALAPPDATA%` / `~/.local/share` is writable by every process the user
	 * runs, so between the install and the next "Test engine" click anything at all can have
	 * overwritten the binary or repointed `installed.json` at one of its own — and the plugin
	 * would spawn it, from a path it trusts, with the user's privileges. Re-hashing costs one
	 * streaming read of ~50 MB once per engine start, which is nothing next to the model load
	 * that follows it. Fail CLOSED: a record with no `exeSha256` (an older build wrote it) is
	 * refused too, because "no checksum" and "a checksum an attacker chose" are the same claim.
	 *
	 * The BYO path is deliberately NOT hashed: the user pointed at that file themselves, we
	 * have no digest to compare it to, and inventing one (trust-on-first-use) would only mean
	 * recording whatever was there the first time we looked.
	 */
	private async resolveExecutable(): Promise<string | null> {
		const node = this.requireNode();
		const byo = (this.settings.enginePath ?? "").trim();
		if (byo) {
			try {
				return await node.fs.promises.realpath(byo);
			} catch {
				this.state = "error";
				this.lastError = `No engine at ${byo}.`;
				return null;
			}
		}
		const installed = await this.readInstalled();
		if (!installed) return null;

		let real: string;
		try {
			real = await node.fs.promises.realpath(installed.exePath);
		} catch {
			return null;
		}

		const expected = String(installed.exeSha256 ?? "").toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(expected)) {
			this.state = "error";
			this.lastError =
				"The engine install record has no checksum for the binary, so it was not started. Remove the engine and download it again.";
			return null;
		}

		let actual: string;
		try {
			actual = await this.hashFile(node, real);
		} catch {
			this.state = "error";
			this.lastError = "The installed engine binary could not be read, so it was not started.";
			return null;
		}
		if (actual !== expected) {
			this.state = "error";
			this.lastError =
				"The installed engine binary does not match the checksum recorded when it was installed, so it was NOT started. Something replaced it. Remove the engine and download it again.";
			return null;
		}
		return real;
	}

	/**
	 * SHA-256 of a file on disk, streamed a megabyte at a time — the engine binary is tens of
	 * megabytes and `readFile` would hold all of it in the renderer's heap at once.
	 */
	private async hashFile(node: NodeApi, target: string): Promise<string> {
		const hash = node.crypto.createHash("sha256");
		const handle = await node.fs.promises.open(target, "r");
		try {
			const buffer = new Uint8Array(1 << 20);
			for (;;) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead <= 0) break;
				hash.update(buffer.subarray(0, bytesRead));
			}
		} finally {
			await handle.close();
		}
		return String(hash.digest("hex")).toLowerCase();
	}

	private async startAt(node: NodeApi, exePath: string): Promise<EngineHealth> {
		this.state = "starting";
		this.lastError = undefined;
		await this.reapOrphan(node);

		const parentPid: number = node.proc.pid;
		const cwd: string = node.path.dirname(exePath);

		let child;
		try {
			child = node.cp.spawn(
				exePath,
				["--stdio", "--parent-pid", String(parentPid), "--idle-exit", String(IDLE_EXIT_SECONDS)],
				{
					cwd,
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...node.proc.env, PYTHONUNBUFFERED: "1" },
				}
			);
		} catch (err) {
			this.state = "error";
			this.lastError = describeSpawnFailure(err);
			throw new EngineRpcError(ERROR_CODES.IO_ERROR, this.lastError);
		}

		this.child = child;
		this.childExePath = exePath;
		this.decoder.reset();

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (text: string) => this.onStdout(text));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text: string) => this.onStderr(text));
		child.on("error", (err: unknown) => this.onChildDown(describeSpawnFailure(err)));
		child.on("exit", (code: number | null, signal: string | null) =>
			this.onChildDown(
				signal === "SIGKILL"
					? describeSpawnFailure({ signal })
					: `The engine exited (code ${String(code)}).`
			)
		);

		await this.writePid(node, child.pid, exePath);
		this.startSweep();

		try {
			const health = await this.request<EngineHealth>("health", undefined, {
				timeoutMs: HEALTH_TIMEOUT_MS,
			});
			this.lastHealth = health;
			this.state = "running";
			return health;
		} catch (err) {
			// A process that vanishes on Windows with no output is Defender, essentially always.
			if (!this.child && node.os.platform() === "win32") {
				this.lastError =
					"Your antivirus may have quarantined the engine. Check its quarantine list, or set a path to an existing engine.";
			}
			this.dispose(true);
			this.state = "error";
			if (!this.lastError) this.lastError = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/* ----------------------------------------------------------------- rpc */

	/** One JSON-RPC round trip. Rejects with EngineRpcError carrying one of ERROR_CODES. */
	async request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
		if (this.disposed) throw new EngineRpcError(ERROR_CODES.IO_ERROR, "The engine host was unloaded.");
		if (!this.child && method !== "health") {
			const health = await this.ensureStarted();
			if (!health) throw new EngineRpcError(ERROR_CODES.UNSUPPORTED, "The semantic engine is not installed.");
		}
		const child = this.child;
		if (!child) throw new EngineRpcError(ERROR_CODES.IO_ERROR, "The engine is not running.");

		const id = this.pending.nextId();
		const timeoutMs = options?.timeoutMs ?? timeoutFor(method);

		return new Promise<T>((resolve, reject) => {
			this.pending.add(id, {
				method,
				now: Date.now(),
				timeoutMs,
				meta: {
					resolve: resolve as (value: unknown) => void,
					reject,
					onProgress: options?.onProgress,
				},
			});
			// BEFORE the write, synchronously: the caller needs the id in order to cancel this
			// request, and a `query` that completes in one frame emits no progress notification,
			// so there is no other moment at which it could ever learn it.
			options?.onRequestId?.(id);
			try {
				child.stdin.write(encodeRequest(id, method, params));
			} catch (err) {
				this.pending.drop(id);
				reject(new EngineRpcError(ERROR_CODES.IO_ERROR, describeSpawnFailure(err)));
			}
		});
	}

	/** A superseding keystroke kills the in-flight batch (DESIGN 6.2, method 8). */
	async cancel(forId: number): Promise<void> {
		if (!this.child) return;
		try {
			await this.request("cancel", { for: forId }, { timeoutMs: 5000 });
		} catch {
			/* a cancel that fails is not worth surfacing */
		}
	}

	private onStdout(text: string): void {
		let decoded;
		try {
			decoded = this.decoder.push(text);
		} catch (err) {
			this.onChildDown(err instanceof Error ? err.message : String(err));
			return;
		}
		for (const line of decoded.malformed) {
			this.pushLog(`[protocol] discarded a non-JSON stdout line: ${line.slice(0, 200)}`);
		}
		for (const message of decoded.messages) {
			const routed = this.pending.route(message);
			switch (routed.kind) {
				case "result":
					routed.entry.meta?.resolve(routed.result);
					break;
				case "error":
					routed.entry.meta?.reject(this.toRpcError(routed.error));
					break;
				case "progress":
					routed.entry?.meta?.onProgress?.(routed.params as unknown as EngineProgress);
					break;
				case "unmatched":
					this.pushLog(`[protocol] response for unknown id ${routed.id} (late or duplicate) — dropped`);
					break;
				case "invalid":
					this.pushLog("[protocol] discarded a frame that is neither a response nor a notification");
					break;
				default:
					break;
			}
		}
	}

	private toRpcError(error: EngineWireError): EngineRpcError {
		return new EngineRpcError(error.code, error.message);
	}

	private onStderr(text: string): void {
		this.stderrTail += text;
		const lines = this.stderrTail.split("\n");
		this.stderrTail = lines.pop() ?? "";
		for (const line of lines) this.pushLog(line);
	}

	private pushLog(line: string): void {
		this.stderrRing.push(line);
		while (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
	}

	private startSweep(): void {
		if (this.sweepTimer !== null) return;
		this.sweepTimer = window.setInterval(() => {
			const now = Date.now();
			for (const entry of this.pending.expired(now)) {
				const wire = this.pending.timeoutError(entry);
				entry.meta?.reject(this.toRpcError(wire));
			}
		}, SWEEP_INTERVAL_MS);
	}

	private stopSweep(): void {
		if (this.sweepTimer === null) return;
		window.clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	private onChildDown(reason: string): void {
		const wasRunning = this.child !== null;
		this.child = null;
		this.lastHealth = null;
		this.stopSweep();
		this.decoder.reset();
		for (const entry of this.pending.drain()) {
			entry.meta?.reject(new EngineRpcError(ERROR_CODES.IO_ERROR, reason));
		}
		if (wasRunning && this.state !== "error") this.state = "installed";
		if (wasRunning) this.pushLog(`[host] ${reason}`);
	}

	/* ------------------------------------------------------------- teardown */

	/**
	 * Kill the child. Called from EngineBroker when the LAST plugin releases, and from
	 * onunload(). Three independent kill paths exist so a zombie is impossible: this
	 * one, the sidecar's stdin-EOF read loop, and its --parent-pid watchdog.
	 */
	dispose(keepDisposedFlag = false): void {
		if (!keepDisposedFlag) this.disposed = true;
		const node = this.node;
		const child = this.child;
		const exePath = this.childExePath;
		this.stopSweep();
		this.child = null;
		this.childExePath = null;
		this.lastHealth = null;
		for (const entry of this.pending.drain()) {
			entry.meta?.reject(new EngineRpcError(ERROR_CODES.IO_ERROR, "The engine was stopped."));
		}
		if (!child || !node) return;

		const pid = child.pid;
		try {
			child.stdin.end(); // stdin EOF: the sidecar's read loop ends and it exits(0).
		} catch {
			/* already gone */
		}
		try {
			child.kill();
		} catch {
			/* already gone */
		}

		if (node.os.platform() === "win32" && typeof pid === "number" && exePath) {
			// SIGTERM is not a thing on Windows; a PyInstaller onedir also has no children of
			// its own, but /T is free insurance against one appearing. The two-second grace is
			// long enough for the OS to have recycled this pid onto somebody else's process, so
			// the kill is identity-checked rather than fired blind at a number.
			window.setTimeout(() => {
				void this.killIfEngine(node, pid, exePath, "shutdown");
			}, WIN_KILL_GRACE_MS);
		}
		void this.quietRm(node, this.pidFile(node));
	}

	/* ----------------------------------------------------------- pid safety */

	/**
	 * THE PID FILE IS PER VAULT. It used to be one machine-wide `engine.pid`, and that is a
	 * bug with teeth: open vault A (engine pid 1234, recorded), then open vault B in a second
	 * window. B's start reads the record, sees a matching exe path and a pid that is very much
	 * alive — because it is A's LIVE engine, not an orphan — and taskkill /T /F's it. A's next
	 * request respawns and reaps B's. The two windows ping-pong forever and the semantic
	 * features thrash in both. Scoping the file by vault key means a window can only ever reap
	 * an engine belonging to the vault it has open.
	 */
	private pidFile(node: NodeApi): string {
		return node.path.join(engineHome(node), `engine.${this.vaultKey()}.pid`);
	}

	/**
	 * Record what we spawned. If Obsidian is killed (crash, force-quit) neither dispose() nor
	 * stdin-EOF runs, and only the sidecar's own --parent-pid watchdog would reap it — up to
	 * 5 s later, and never at all if that watchdog regressed. So the next start reaps whatever
	 * is still recorded here.
	 *
	 * `parentPid` is what makes that safe. A record whose parent is still running is not an
	 * orphan; it belongs to a live session and must never be touched.
	 */
	private async writePid(node: NodeApi, pid: number | undefined, exePath: string): Promise<void> {
		if (typeof pid !== "number") return;
		try {
			await node.fs.promises.writeFile(
				this.pidFile(node),
				JSON.stringify({
					pid,
					exePath,
					parentPid: node.proc.pid,
					vaultKey: this.vaultKey(),
					startedAt: Date.now(),
				}) + "\n"
			);
		} catch {
			/* a missing pid file costs us a slower reap, nothing more */
		}
	}

	/**
	 * Kill the engine a previous session left behind — and NOTHING else.
	 *
	 * Two ways the old version killed a stranger, both of them real:
	 *  1. A live sibling. Fixed by the per-vault pid file plus the parent check below: a
	 *     record whose parent process is still alive is a running session, not an orphan.
	 *  2. Pid reuse. `engine.pid` survives a crash AND a reboot; Windows pids are small and
	 *     recycled aggressively, so "something is alive at pid 1234" says nothing about WHAT.
	 *     The liveness probe passed and the host ran `taskkill /PID 1234 /T /F` on whatever
	 *     now owned that number. Fixed by verifying the live process's image name against the
	 *     executable we recorded before any signal is sent.
	 */
	private async reapOrphan(node: NodeApi): Promise<void> {
		const pidFile = this.pidFile(node);
		let record: { pid?: number; exePath?: string; parentPid?: number } | null = null;
		try {
			record = JSON.parse(await node.fs.promises.readFile(pidFile, "utf8")) as {
				pid?: number;
				exePath?: string;
				parentPid?: number;
			};
		} catch {
			return;
		}
		if (!record || typeof record.pid !== "number" || typeof record.exePath !== "string") return;
		if (record.pid === node.proc.pid) return; // never, ever signal the renderer

		// Is anything alive at that pid at all?
		try {
			node.proc.kill(record.pid, 0); // liveness probe; throws ESRCH when gone
		} catch {
			await this.quietRm(node, pidFile);
			return;
		}

		// Is the session that spawned it gone? A live parent means a live sibling — another
		// window with this vault open, or this very renderer having already started an engine.
		// Only our own renderer's leftovers are ours to reap.
		if (typeof record.parentPid === "number" && record.parentPid !== node.proc.pid) {
			let parentAlive = true;
			try {
				node.proc.kill(record.parentPid, 0);
			} catch {
				parentAlive = false;
			}
			if (parentAlive) {
				this.pushLog(
					`[host] engine pid ${record.pid} belongs to a live session (parent ${record.parentPid}) — leaving it alone`
				);
				return;
			}
		}

		const killed = await this.killIfEngine(node, record.pid, record.exePath, "orphan");
		if (killed) {
			this.pushLog(`[host] reaped an orphaned engine (pid ${record.pid}) left by a previous session`);
		}
		await this.quietRm(node, pidFile);
	}

	/**
	 * Signal `pid` ONLY if the process actually running under it is the engine we think it is.
	 * A pid is not an identity — it is a number the OS hands out again the moment it is free.
	 */
	private async killIfEngine(node: NodeApi, pid: number, exePath: string, why: string): Promise<boolean> {
		const expected = String(node.path.basename(exePath)).toLowerCase();
		const actual = (await this.processImageName(node, pid))?.toLowerCase() ?? null;
		if (!actual) return false; // it exited, or we cannot tell — either way, do not shoot
		// POSIX `comm` truncates at 15 chars, so compare on the prefix rather than for equality.
		const matches = actual === expected || expected.startsWith(actual) || actual.startsWith(expected);
		if (!matches) {
			this.pushLog(`[host] pid ${pid} is "${actual}", not "${expected}" — refusing to kill it (${why})`);
			return false;
		}
		try {
			if (node.os.platform() === "win32") {
				node.cp.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
			} else {
				node.proc.kill(pid, "SIGTERM");
			}
			return true;
		} catch {
			return false; // it died between the check and the signal. Fine.
		}
	}

	/** The image name of the process at `pid`, or null when there is nothing there (or we
	 *  cannot find out — in which case the caller must not kill). */
	private processImageName(node: NodeApi, pid: number): Promise<string | null> {
		const win32 = node.os.platform() === "win32";
		const command = win32 ? "tasklist" : "ps";
		const args = win32
			? ["/FI", `PID eq ${String(pid)}`, "/FO", "CSV", "/NH"]
			: ["-p", String(pid), "-o", "comm="];

		return new Promise<string | null>((resolve) => {
			try {
				node.cp.execFile(
					command,
					args,
					{ timeout: 5_000, windowsHide: true },
					(err: unknown, stdout: string) => {
						if (err || typeof stdout !== "string") {
							resolve(null);
							return;
						}
						const text = stdout.trim();
						if (!text) {
							resolve(null);
							return;
						}
						if (win32) {
							// `"embed-sidecar.exe","1234","Console","1","96,152 K"`, or an
							// INFO: line when the filter matched nothing.
							const match = /^"([^"]+)"/.exec(text);
							resolve(match ? match[1] : null);
							return;
						}
						// `ps -o comm=` prints the command, possibly a full path.
						const first = text.split("\n")[0].trim();
						resolve(first ? String(node.path.basename(first)) : null);
					}
				);
			} catch {
				resolve(null);
			}
		});
	}

	/* ------------------------------------------------------------ download */

	/**
	 * Node `https.get` -> `fs.createWriteStream`, hashing as the bytes land. Returns the
	 * SHA-256 of exactly the bytes that were written, which is what step 2 compares.
	 *
	 * Redirects are followed only onto ALLOWED_DOWNLOAD_HOSTS, and only over HTTPS —
	 * a release asset 302s to GitHub's object store, and an open redirect chain is how
	 * a pinned checksum gets quietly pointed at somebody else's bytes.
	 */
	private download(
		node: NodeApi,
		url: string,
		dest: string,
		onProgress: (done: number, total: number) => void
	): Promise<string> {
		const { fs, https, crypto } = node;

		return new Promise<string>((resolve, reject) => {
			let hops = 0;
			let settled = false;
			let out: import("fs").WriteStream | null = null;
			const fail = (err: unknown) => {
				if (settled) return;
				settled = true;
				// Destroy the write stream. Rejecting the promise does not close the fd: on a
				// mid-download network drop it leaked, and on Windows the quietRm(tmpZip) that
				// follows would then lose to an EBUSY and leave a half-downloaded .part behind.
				try {
					out?.destroy();
				} catch {
					/* already closed */
				}
				reject(
					err instanceof EngineRpcError
						? err
						: new EngineRpcError(ERROR_CODES.IO_ERROR, describeSpawnFailure(err))
				);
			};

			const get = (current: string) => {
				if (!isAllowedDownloadUrl(current)) {
					fail(new EngineRpcError(ERROR_CODES.IO_ERROR, `Refusing to download from ${current}.`));
					return;
				}
				const req = https.get(
					current,
					{ headers: { "user-agent": "second-read-engine-installer", accept: "application/octet-stream" } },
					(res) => {
						const status: number = res.statusCode ?? 0;
						const location: string | undefined = res.headers?.location;

						if (status >= 300 && status < 400 && location) {
							res.resume();
							if (++hops > MAX_REDIRECTS) {
								fail(new EngineRpcError(ERROR_CODES.IO_ERROR, "Too many redirects."));
								return;
							}
							let next: string;
							try {
								next = new URL(location, current).toString();
							} catch {
								fail(new EngineRpcError(ERROR_CODES.IO_ERROR, "The server sent a redirect we cannot parse."));
								return;
							}
							get(next);
							return;
						}

						if (status !== 200) {
							res.resume();
							fail(new EngineRpcError(ERROR_CODES.IO_ERROR, `Download failed (HTTP ${status}).`));
							return;
						}

						const total = Number(res.headers?.["content-length"] ?? 0) || 0;
						// The checksum can only be checked once the bytes have landed, so the
						// size is the only thing standing between a compromised (but
						// allowlisted) host and an unbounded write into the user's app-data
						// directory. Trust the server's own Content-Length to within 4x, and
						// never past the hard ceiling whatever it claims.
						const cap = total > 0 ? Math.min(MAX_DOWNLOAD_BYTES, total * 4) : MAX_DOWNLOAD_BYTES;
						let done = 0;
						const hash = crypto.createHash("sha256");
						out = fs.createWriteStream(dest);

						res.on("data", (buf: Uint8Array) => {
							done += buf.length;
							if (done > cap) {
								res.destroy();
								req.destroy();
								fail(
									new EngineRpcError(
										ERROR_CODES.IO_ERROR,
										"The download is larger than the engine could possibly be — it was stopped and nothing was run."
									)
								);
								return;
							}
							hash.update(buf);
							onProgress(done, total);
						});
						res.on("error", fail);
						out.on("error", fail);
						out.on("finish", () => {
							if (settled) return;
							settled = true;
							resolve(String(hash.digest("hex")).toLowerCase());
						});
						res.pipe(out);
					}
				);
				req.on("error", fail);
				req.setTimeout(DOWNLOAD_STALL_MS, () => {
					req.destroy(new Error("The download stalled."));
				});
			};

			get(url);
		});
	}

	/* ------------------------------------------------------------- extract */

	/** Pure-JS unzip (fflate). NEVER shell out to tar/unzip/Expand-Archive. */
	private async extract(node: NodeApi, zipPath: string, destDir: string): Promise<void> {
		const { fs, path } = node;
		const raw: Uint8Array = new Uint8Array(await fs.promises.readFile(zipPath));
		const entries = unzipSync(raw);

		for (const name of Object.keys(entries)) {
			if (name.endsWith("/")) continue;
			const target = safeEntryPath(node, destDir, name);
			if (!target) {
				throw new EngineRpcError(
					ERROR_CODES.IO_ERROR,
					`The archive contains an entry that would escape the install directory (${name}) — nothing was installed.`
				);
			}
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, entries[name]);
		}
	}

	/**
	 * The onedir's executable, whether or not the zip has a top-level folder.
	 *
	 * A FILE, tested with stat — not `existsSync`. PyInstaller's onedir layout routinely names
	 * the top-level folder after the executable (`embed-sidecar/embed-sidecar`), so `existsSync`
	 * on `<binDir>/embed-sidecar` is true for the DIRECTORY, and the installer would then record
	 * a directory as `exePath`, spawn it, and report a confusing EACCES/EISDIR instead of
	 * descending one level to the real binary.
	 */
	private async findExecutable(node: NodeApi, dir: string, exe: string): Promise<string | null> {
		const { fs, path } = node;
		const isFile = async (target: string): Promise<boolean> => {
			try {
				return (await fs.promises.stat(target)).isFile();
			} catch {
				return false;
			}
		};

		const direct: string = path.join(dir, exe);
		if (await isFile(direct)) return direct;
		let names: string[];
		try {
			names = await fs.promises.readdir(dir);
		} catch {
			return null;
		}
		for (const name of names.sort()) {
			const candidate: string = path.join(dir, name, exe);
			if (await isFile(candidate)) return candidate;
		}
		return null;
	}

	/** Old versions under bin/ are dead weight; drop them once the new one has answered `health`. */
	private async pruneOldVersions(node: NodeApi, home: string, keep: string): Promise<void> {
		const { fs, path } = node;
		const binRoot: string = path.join(home, "bin");
		let names: string[];
		try {
			names = await fs.promises.readdir(binRoot);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === keep) continue;
			await this.quietRmDir(node, path.join(binRoot, name));
		}
	}

	/* -------------------------------------------------------------- helpers */

	private requireNode(): NodeApi {
		if (!this.node) {
			throw new UnsupportedPlatformError("mobile", "");
		}
		return this.node;
	}

	private async quietRm(node: NodeApi, target: string): Promise<void> {
		try {
			await node.fs.promises.rm(target, { force: true });
		} catch {
			/* it was already not there */
		}
	}

	private async quietRmDir(node: NodeApi, target: string): Promise<void> {
		try {
			await node.fs.promises.rm(target, { recursive: true, force: true });
		} catch {
			/* it was already not there */
		}
	}
}

/** Re-exported so a plugin can render the expected model/dim without importing the generated file. */
export { ENGINE_VERSION, ENGINE_MODEL, ENGINE_DIM };
