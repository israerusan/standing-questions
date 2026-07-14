/**
 * THE SHARED ENGINE HOST, FROM THIS ADD-ON'S SIDE.
 *
 * One engine process is shared by every Second Read add-on in the vault, through one EngineHost
 * object in one realm global. That sharing is what makes "Remove engine" and "Path to an existing
 * engine" dangerous: they are per-add-on buttons that mutate an object the OTHER add-ons are
 * holding. Both had a defect that only appears with a SECOND add-on loaded — which is why they
 * survived a full review of the single-plugin paths.
 *
 * This file loads the vendored host with a fake `window.require` (real fs/path/crypto over a temp
 * dir; no process is ever spawned) and drives the SHIPPED `StandingQuestionsPlugin.removeEngine`
 * and `saveSettings` against it, with Prior Art holding a ref the whole time.
 *
 *   1. Remove engine must not poison the shared host. (Upstream fix: `remove()` → `dispose(true)`.
 *      Verified from this side, because this side is where the button is.)
 *   2. This add-on's BYO engine path must be attributed to THIS add-on, so it cannot outrank
 *      Prior Art's path, and cannot outlive our own unload.
 *
 * (Everything is inside main(). The test bundle is CJS, where esbuild rejects top-level await.)
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Platform } from "obsidian";
import StandingQuestionsPlugin from "../src/main";
import { EngineBroker } from "../src/shared/engine/EngineBroker";
import type { EngineHost } from "../src/shared/engine/EngineHost";

/* ------------------------------------------------------- a desktop, faked -- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sq-engine-"));
const ENGINE_HOME_DIR = "second-read-engine";

/** The same branch EngineHost.engineHome() takes, for the same fake os/proc. */
function engineHome(): string {
	if (process.platform === "win32") return path.join(tmp, "Local", ENGINE_HOME_DIR);
	if (process.platform === "darwin") {
		return path.join(tmp, "Library", "Application Support", ENGINE_HOME_DIR);
	}
	return path.join(tmp, "share", ENGINE_HOME_DIR);
}

/**
 * Records the executable the host was about to launch, then refuses. There is no real sidecar in
 * a test, and the exe path is exactly what we need to observe: it is the ONLY way to see which
 * add-on's BYO path won.
 */
const spawned: string[] = [];
const fakeCp = {
	spawn: (exePath: string) => {
		spawned.push(exePath);
		throw new Error("no real engine process in tests");
	},
};
const fakeHttps = {
	get: () => {
		throw new Error("the network was touched while removing an engine");
	},
};
const fakeOs = { platform: () => process.platform, homedir: () => tmp };
const fakeProc = {
	env: { LOCALAPPDATA: path.join(tmp, "Local"), XDG_DATA_HOME: path.join(tmp, "share") },
	pid: process.pid,
	kill: () => undefined,
};

const nodeModules: Record<string, unknown> = {
	child_process: fakeCp,
	fs,
	https: fakeHttps,
	os: fakeOs,
	path,
	crypto,
	process: fakeProc,
};

Platform.isDesktop = true;
(globalThis as unknown as { window: unknown }).window = {
	require: (id: string) => nodeModules[id],
	setTimeout: globalThis.setTimeout.bind(globalThis),
	clearTimeout: globalThis.clearTimeout.bind(globalThis),
	setInterval: globalThis.setInterval.bind(globalThis),
	clearInterval: globalThis.clearInterval.bind(globalThis),
};

const app = {
	vault: { adapter: {}, getName: () => "TestVault" },
} as never;

/** An installed engine, on disk, with no engine. Enough for readInstalled() to see it. */
function pretendAnEngineIsInstalled(): void {
	const home = engineHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, "bin", "engine"), "#!/bin/sh\nexit 0\n");
	fs.writeFileSync(
		path.join(home, "installed.json"),
		JSON.stringify({
			version: "1.0.0",
			target: "win-x64",
			sha256: "a".repeat(64),
			installedAt: Date.now(),
			exePath: path.join(home, "bin", "engine"),
		})
	);
}

/** The shipped plugin methods, run against a hand-built `this`. No Obsidian, no onload(). */
function pluginStub(host: EngineHost | null, over: Record<string, unknown> = {}) {
	return {
		app,
		engine: host,
		engineIndex: { reset: () => undefined },
		manifest: { id: "standing-questions" },
		settings: { enginePath: "" },
		index: { updateSettings: () => undefined },
		saveData: () => Promise.resolve(),
		clearTimer: () => undefined,
		saveTimer: null,
		scheduleIndex: () => undefined,
		refreshEngineStatus: () => Promise.resolve(null),
		...over,
	};
}

const removeEngine = StandingQuestionsPlugin.prototype.removeEngine;
const saveSettings = StandingQuestionsPlugin.prototype.saveSettings;

async function main(): Promise<void> {
	/* ================================================================== F1 ====
	 * "Remove engine", with Prior Art loaded.
	 *
	 * The old vendored `remove()` called the unqualified `dispose()`, which latches
	 * `disposed = true` on the object FOREVER. The host is shared, so that one click made every
	 * later call — in BOTH add-ons, including the `health` handshake inside a fresh install() —
	 * throw "The engine host was unloaded." until Obsidian restarted. This add-on's workaround
	 * (release, then re-acquire) could not save it: with Prior Art holding a ref the refcount
	 * never reaches zero, release() returns early, and acquire() handed back the same corpse.
	 * ======================================================================== */
	{
		const priorArt = EngineBroker.acquire(app, "prior-art", {});
		assert.ok(priorArt, "the fake desktop is wired: a host exists");

		const sq = EngineBroker.acquire(app, "standing-questions", {});
		assert.equal(sq, priorArt, "both add-ons share ONE host — that is the whole point of it");
		assert.deepEqual(EngineBroker.refs(), ["prior-art", "standing-questions"]);

		pretendAnEngineIsInstalled();
		assert.ok((await sq!.status()).installed, "an engine is installed before we remove it");

		await removeEngine.call(pluginStub(sq) as never);
		assert.deepEqual(spawned, [], "removing an engine starts no process and touches no network");

		// The binary is gone...
		assert.ok(!fs.existsSync(path.join(engineHome(), "bin")), "the binaries are deleted");
		assert.ok(!fs.existsSync(path.join(engineHome(), "installed.json")), "and the install record");
		assert.equal((await sq!.status()).installed, null);

		// ...and the HOST is not. This is the fix.
		assert.ok(
			!sq!.isDisposed(),
			"removing the binary must leave the shared host usable and empty, not dead — Prior Art is " +
				"holding this exact object"
		);
		assert.equal(
			EngineBroker.peek(),
			sq,
			"the host identity is stable across removeEngine(): the settings tab and every other " +
				"add-on reach it through peek(), and swapping it out mid-session is what the deleted " +
				"release/re-acquire workaround did"
		);
		assert.deepEqual(
			EngineBroker.refs(),
			["prior-art", "standing-questions"],
			"and Prior Art's ref survived — it never asked to be released"
		);

		// The proof that matters: Prior Art's next call is a normal "not installed", NOT a dead host.
		// (Prior Art holds `priorArt`, the object it acquired at load — nobody re-reads the global.)
		const err = await priorArt!.request("query", { q: "x" }).then(
			() => null,
			(error: Error) => error
		);
		assert.ok(err, "there is no engine, so of course it fails");
		assert.ok(
			!/unloaded/i.test(err.message),
			`Prior Art's engine was poisoned by OUR remove button: "${err.message}"`
		);
		assert.match(
			err.message,
			/not installed|not running/i,
			"it fails the honest way — the engine is gone, and it can be downloaded again"
		);

		// And this add-on can re-install without a restart: the health handshake inside install()
		// runs through the same request() gate that would have thrown "unloaded".
		assert.ok(!sq!.isDisposed(), "still alive, ready for a re-download");

		EngineBroker.release("standing-questions");
		EngineBroker.release("prior-art");
	}

	/* ================================================================== F4 ====
	 * The BYO path is per-add-on, and saveSettings() must say WHICH add-on.
	 *
	 * The host keeps one settings bucket per plugin id precisely so that N add-ons cannot fight
	 * over a single global `enginePath`. `updateSettings(settings)` with no id lands in the
	 * ANONYMOUS bucket, which sorts first (so it silently outranks Prior Art's real path) and is
	 * never dropped by forgetPlugin() (so it keeps steering the engine after this add-on is
	 * disabled). Both are invisible until a second add-on exists.
	 * ======================================================================== */
	{
		// Two real files, so realpath() resolves either one. Which one the host reaches for is the
		// entire question.
		const priorArtPath = path.join(tmp, "prior-art-engine");
		const ourPath = path.join(tmp, "our-engine");
		fs.writeFileSync(priorArtPath, "#!/bin/sh\nexit 0\n");
		fs.writeFileSync(ourPath, "#!/bin/sh\nexit 0\n");

		/** The exe the host would launch right now, observed through the spawn it attempts. */
		const wouldLaunch = async (host: EngineHost): Promise<string | undefined> => {
			spawned.length = 0;
			await host.request("query", { q: "x" }).catch(() => undefined);
			return spawned[0];
		};

		const priorArt = EngineBroker.acquire(app, "prior-art", { enginePath: priorArtPath });
		const sq = EngineBroker.acquire(app, "standing-questions", {});
		assert.equal(sq, priorArt);
		assert.ok((await sq!.status()).byoPath, "Prior Art's BYO path is steering the shared host");

		// The user types a path into OUR settings tab, and it saves.
		const plugin = pluginStub(sq, { settings: { enginePath: ourPath } });
		await saveSettings.call(plugin as never);

		assert.equal(
			await wouldLaunch(sq!),
			priorArtPath,
			"the shared host resolves BYO paths deterministically (first non-empty, by plugin id) — " +
				"NOT 'whichever add-on saved its settings last'. An unattributed path lands in the " +
				"anonymous bucket, which sorts ahead of every real add-on and silently hijacks the engine."
		);

		// Now the user disables this add-on. Prior Art stays loaded.
		EngineBroker.release("standing-questions");

		assert.equal(
			await wouldLaunch(priorArt!),
			priorArtPath,
			"after THIS add-on unloads, its BYO path must be forgotten — forgetPlugin() can only drop " +
				"a path that was attributed to a plugin id, so an unattributed one keeps steering Prior " +
				"Art's engine at a binary configured in an add-on that is no longer even loaded"
		);

		EngineBroker.release("prior-art");
		assert.equal(EngineBroker.peek(), null, "the last ref killed the host and cleared the global");
	}

	/* ==========================================================================
	 * "Remove engine" as the ONLY engine add-on — where the deleted workaround did its damage.
	 *
	 * The old removeEngine() released its ref and re-acquired. With no sibling holding a ref that
	 * release ran for real: it DISPOSED the host, killed the child and cleared the realm global,
	 * and acquire() then built a brand-new host object. Anything still holding the old one (the
	 * settings tab, the engine-log modal) was holding a corpse that throws "The engine host was
	 * unloaded." from every call — and the engine log, which is the only thing a user has when the
	 * engine will not start, was silently emptied. Removing a binary must not swap the host.
	 * ======================================================================== */
	{
		pretendAnEngineIsInstalled();
		const sq = EngineBroker.acquire(app, "standing-questions", {});
		assert.deepEqual(EngineBroker.refs(), ["standing-questions"], "we are the only engine add-on");

		await removeEngine.call(pluginStub(sq) as never);

		assert.ok(!sq!.isDisposed(), "the host this add-on is holding must survive its own remove button");
		assert.equal(
			EngineBroker.peek(),
			sq,
			"and it must be the SAME host — release-then-re-acquire silently swaps the object out from " +
				"under every holder of it"
		);
		assert.deepEqual(EngineBroker.refs(), ["standing-questions"], "our ref is intact");
		assert.equal((await sq!.status()).installed, null, "and the engine really is gone");

		EngineBroker.release("standing-questions");
	}

	fs.rmSync(tmp, { recursive: true, force: true });
}

/** test/run.mjs awaits this, so a rejected assertion fails the run at THIS file. */
export const done = main();
