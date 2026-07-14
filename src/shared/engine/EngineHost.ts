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
	executableName,
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
	sha256: string;
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
}

/* ------------------------------------------------------ Node, lazily typed -- */

/* eslint-disable @typescript-eslint/no-explicit-any */
type NodeRequire = (id: string) => any;

interface NodeApi {
	cp: any;
	fs: any;
	https: any;
	os: any;
	path: any;
	crypto: any;
	proc: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** ~45 MB over a bad hotel connection is still under this. */
const DOWNLOAD_STALL_MS = 60_000;
const MAX_REDIRECTS = 5;
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
			cp: req("child_process"),
			fs: req("fs"),
			https: req("https"),
			os: req("os"),
			path: req("path"),
			crypto: req("crypto"),
			proc: req("process"),
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
	private settings: EngineSettings;
	private readonly node: NodeApi | null;

	private child: { pid?: number; stdin: any; stdout: any; stderr: any; kill: (s?: string) => void } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
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

	constructor(app: App, settings: EngineSettings) {
		this.app = app;
		this.settings = { ...settings };
		this.node = loadNode();
		if (!this.node) this.state = "unsupported";
	}

	/* --------------------------------------------------------- introspection */

	/** The plugin's engine settings changed (e.g. the user typed a BYO path). Not a restart. */
	updateSettings(settings: EngineSettings): void {
		this.settings = { ...settings };
	}

	get desktop(): boolean {
		return this.node !== null;
	}

	isAlive(): boolean {
		return this.child !== null;
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
		const health = await this.startAt(node, real);

		const info: InstalledInfo = {
			version: plan.version,
			target: plan.target,
			sha256: plan.sha256,
			installedAt: Date.now(),
			exePath: real,
		};
		await fs.promises.writeFile(path.join(home, "installed.json"), JSON.stringify(info, null, 2) + "\n");
		await this.pruneOldVersions(node, home, plan.version);

		onProgress?.({ phase: "ready", message: `Engine ready — ${health.model}, ${health.dim}-dim.` });
		return health;
	}

	/** Kill the child, delete the binaries, forget the install. The index is deliberately KEPT. */
	async remove(): Promise<void> {
		const node = this.requireNode();
		this.dispose();
		const home = engineHome(node);
		await this.quietRmDir(node, node.path.join(home, "bin"));
		await this.quietRm(node, node.path.join(home, "installed.json"));
		await this.quietRm(node, node.path.join(home, "engine.pid"));
		this.state = "not-installed";
		this.lastHealth = null;
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

	/** BYO path wins over anything downloaded — that is the point of it. */
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
		try {
			return await node.fs.promises.realpath(installed.exePath);
		} catch {
			return null;
		}
	}

	private async startAt(node: NodeApi, exePath: string): Promise<EngineHealth> {
		this.state = "starting";
		this.lastError = undefined;
		await this.reapOrphan(node, exePath);

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
			const health = (await this.request("health", undefined, {
				timeoutMs: HEALTH_TIMEOUT_MS,
			})) as EngineHealth;
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
		this.stopSweep();
		this.child = null;
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

		if (node.os.platform() === "win32" && typeof pid === "number") {
			// SIGTERM is not a thing on Windows; a PyInstaller onedir also has no children
			// of its own, but /T is free insurance against one appearing.
			window.setTimeout(() => {
				try {
					node.cp.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
				} catch {
					/* nothing left to kill */
				}
			}, WIN_KILL_GRACE_MS);
		}
		void this.quietRm(node, node.path.join(engineHome(node), "engine.pid"));
	}

	/* ----------------------------------------------------------- pid safety */

	/**
	 * We record the pid we spawned. If Obsidian is killed (crash, force-quit) neither
	 * dispose() nor stdin-EOF runs, and only the sidecar's own --parent-pid watchdog
	 * would reap it — up to 5 s later, and never at all if that watchdog regressed.
	 * So on the next start we kill anything still recorded here, but ONLY if the
	 * recorded exe path is the one we are about to launch: a recycled pid belonging to
	 * some other program must never be touched.
	 */
	private async writePid(node: NodeApi, pid: number | undefined, exePath: string): Promise<void> {
		if (typeof pid !== "number") return;
		try {
			await node.fs.promises.writeFile(
				node.path.join(engineHome(node), "engine.pid"),
				JSON.stringify({ pid, exePath, startedAt: Date.now() }) + "\n"
			);
		} catch {
			/* a missing pid file costs us a slower reap, nothing more */
		}
	}

	private async reapOrphan(node: NodeApi, exePath: string): Promise<void> {
		const pidFile = node.path.join(engineHome(node), "engine.pid");
		let record: { pid?: number; exePath?: string } | null = null;
		try {
			record = JSON.parse(await node.fs.promises.readFile(pidFile, "utf8"));
		} catch {
			return;
		}
		if (!record || typeof record.pid !== "number" || record.exePath !== exePath) return;
		if (record.pid === node.proc.pid) return;
		try {
			node.proc.kill(record.pid, 0); // liveness probe; throws ESRCH when gone
		} catch {
			await this.quietRm(node, pidFile);
			return;
		}
		try {
			if (node.os.platform() === "win32") {
				node.cp.execFile("taskkill", ["/PID", String(record.pid), "/T", "/F"], () => undefined);
			} else {
				node.proc.kill(record.pid, "SIGTERM");
			}
			this.pushLog(`[host] reaped an orphaned engine (pid ${record.pid}) left by a previous session`);
		} catch {
			/* nothing to do */
		}
		await this.quietRm(node, pidFile);
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
			const fail = (err: unknown) => {
				if (settled) return;
				settled = true;
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
					(res: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
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
						let done = 0;
						const hash = crypto.createHash("sha256");
						const out = fs.createWriteStream(dest);

						res.on("data", (buf: Uint8Array) => {
							done += buf.length;
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

	/** The onedir's executable, whether or not the zip has a top-level folder. */
	private async findExecutable(node: NodeApi, dir: string, exe: string): Promise<string | null> {
		const { fs, path } = node;
		const direct: string = path.join(dir, exe);
		if (fs.existsSync(direct)) return direct;
		let names: string[];
		try {
			names = await fs.promises.readdir(dir);
		} catch {
			return null;
		}
		for (const name of names.sort()) {
			const candidate: string = path.join(dir, name, exe);
			if (fs.existsSync(candidate)) return candidate;
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
