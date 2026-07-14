// Where the engine lands on disk (DESIGN 7.1) — and, crucially, that the CONSENT MODAL names
// the same directory the INSTALLER actually writes to.
//
// The modal's whole job is to state four facts the user can check: the URL, the version, the
// checksum, and the path. Three of those come from the vendored installPlan; the fourth is
// computed HERE, because the vendored EngineHost keeps its `engineHome()` private and exposes
// no getter for it. So the rule is reimplemented in src/core/enginePaths.mjs — and if the two
// ever drift, the consent screen would lie about the one fact it exists to state.
//
// This test reads the VENDORED EngineHost.ts source and pins our copy against it. It is ugly,
// and it is the only thing standing between "the modal is honest" and "the modal is decoration".
// (The right fix is a public `installDir()` on EngineHost in obsidian-plugin-core. Reported.)
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_HOME_DIR, engineHomeDir, engineInstallDir } from "../src/core/enginePaths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = fs.readFileSync(path.join(root, "src/shared/engine/EngineHost.ts"), "utf8");

// --- pinned against the vendored installer ------------------------------------------
assert.match(
	host,
	/const ENGINE_HOME_DIR = "second-read-engine"/,
	"EngineHost's app-data directory name changed — enginePaths.mjs must follow it"
);
assert.equal(ENGINE_HOME_DIR, "second-read-engine");

// The three platform branches, as EngineHost writes them. If any of these greps stops matching,
// the vendored installer has moved and this file has not.
assert.match(host, /proc\.env\.LOCALAPPDATA \|\| path\.join\(home, "AppData", "Local"\)/);
assert.match(host, /path\.join\(home, "Library", "Application Support", ENGINE_HOME_DIR\)/);
assert.match(host, /proc\.env\.XDG_DATA_HOME \|\| path\.join\(home, "\.local", "share"\)/);
assert.match(host, /path\.join\(home, "bin", plan\.version\)/, "the onedir goes in <home>/bin/<version>");

// --- windows ---------------------------------------------------------------------------
{
	const win = { platform: "win32", homedir: "C:\\Users\\you", env: { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" } };
	assert.equal(engineHomeDir(win), "C:\\Users\\you\\AppData\\Local\\second-read-engine");
	assert.equal(
		engineInstallDir(win, "1.0.0"),
		"C:\\Users\\you\\AppData\\Local\\second-read-engine\\bin\\1.0.0"
	);
	// No LOCALAPPDATA (a stripped environment): fall back to the documented default.
	assert.equal(
		engineHomeDir({ platform: "win32", homedir: "C:\\Users\\you", env: {} }),
		"C:\\Users\\you\\AppData\\Local\\second-read-engine"
	);
}

// --- macOS -------------------------------------------------------------------------------
{
	const mac = { platform: "darwin", homedir: "/Users/you", env: {} };
	assert.equal(engineHomeDir(mac), "/Users/you/Library/Application Support/second-read-engine");
	assert.equal(
		engineInstallDir(mac, "1.0.0"),
		"/Users/you/Library/Application Support/second-read-engine/bin/1.0.0"
	);
}

// --- linux, with and without XDG_DATA_HOME --------------------------------------------------
{
	assert.equal(
		engineHomeDir({ platform: "linux", homedir: "/home/you", env: {} }),
		"/home/you/.local/share/second-read-engine"
	);
	assert.equal(
		engineHomeDir({ platform: "linux", homedir: "/home/you", env: { XDG_DATA_HOME: "/home/you/.data" } }),
		"/home/you/.data/second-read-engine"
	);
}

// --- NEVER inside the vault -------------------------------------------------------------------
// "A note-taking app dropped an .exe into a documents folder and ran it" is the EDR escalation
// pattern, and Obsidian Sync would replicate a 100 MB tree to the user's phone.
for (const host of [
	{ platform: "win32", homedir: "C:\\Users\\you", env: {} },
	{ platform: "darwin", homedir: "/Users/you", env: {} },
	{ platform: "linux", homedir: "/home/you", env: {} },
]) {
	const dir = engineInstallDir(host, "1.0.0").replace(/\\/g, "/").toLowerCase();
	assert.ok(!dir.includes(".obsidian"), "the engine is never installed into the vault");
	assert.ok(dir.includes("second-read-engine"));
	assert.ok(dir.endsWith("/bin/1.0.0"));
}

// --- garbage in, no crash -----------------------------------------------------------------------
assert.equal(typeof engineHomeDir({}), "string");
assert.equal(typeof engineInstallDir(undefined, undefined), "string");

console.log("ok  engine-paths.test.mjs");
