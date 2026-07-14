/**
 * Where the semantic engine lands on disk (DESIGN 7.1). Pure: no `obsidian`, no Node — the
 * platform, the home directory and the environment are passed IN, which is the only reason
 * this can be unit-tested for all three operating systems from one machine.
 *
 * WHY THIS FILE EXISTS AT ALL. The consent modal (EngineInstallModal) must show the user the
 * exact directory an executable is about to be written to, and the vendored `EngineHost`
 * computes that path privately — it exposes no getter for it. Rather than reach into the
 * vendored tree (which is byte-checked against obsidian-plugin-core and must never be edited
 * here), the rule from DESIGN 7.1 is reimplemented and PINNED BY A TEST against the exact
 * strings in EngineHost.engineHome().
 *
 * If it ever drifts, the modal would name a directory the installer does not use — i.e. the
 * consent screen would lie about the one fact it exists to state. See engine-paths.test.mjs,
 * and see the note in the return value of this build: the right long-term fix is a public
 * `installDir()` on EngineHost in obsidian-plugin-core, shared by every engine add-on.
 *
 * NEVER inside the vault. "A note-taking app dropped an .exe into a documents folder and ran
 * it" is the EDR escalation pattern, and Obsidian Sync / Dropbox / iCloud would replicate a
 * 100 MB tree under `.obsidian/plugins/**` to the user's phone.
 */

/** The suite-wide app-data directory name. Must equal ENGINE_HOME_DIR in EngineHost.ts. */
export const ENGINE_HOME_DIR = "second-read-engine";

function join(platform, ...parts) {
	const sep = platform === "win32" ? "\\" : "/";
	const cleaned = parts
		.map((part) => String(part ?? ""))
		.filter((part) => part !== "")
		.map((part, i) => {
			const normalized = platform === "win32" ? part.replace(/\//g, "\\") : part;
			// Only the first segment may keep a leading separator (`/home/...`, `C:\...`).
			const head = i === 0 ? normalized : normalized.replace(/^[\\/]+/, "");
			return head.replace(/[\\/]+$/, "");
		});
	return cleaned.join(sep);
}

/**
 * `%LOCALAPPDATA%\second-read-engine`, `~/Library/Application Support/second-read-engine`,
 * or `${XDG_DATA_HOME:-~/.local/share}/second-read-engine`.
 *
 * @param {{platform: string, homedir: string, env?: Record<string, string | undefined>}} host
 */
export function engineHomeDir(host) {
	const platform = String(host?.platform ?? "");
	const home = String(host?.homedir ?? "");
	const env = host?.env ?? {};

	if (platform === "win32") {
		const local = env.LOCALAPPDATA || join(platform, home, "AppData", "Local");
		return join(platform, local, ENGINE_HOME_DIR);
	}
	if (platform === "darwin") {
		return join(platform, home, "Library", "Application Support", ENGINE_HOME_DIR);
	}
	const xdg = env.XDG_DATA_HOME || join(platform, home, ".local", "share");
	return join(platform, xdg, ENGINE_HOME_DIR);
}

/** Where the onedir for `version` is extracted: `<engine home>/bin/<version>`. */
export function engineInstallDir(host, version) {
	return join(String(host?.platform ?? ""), engineHomeDir(host), "bin", String(version ?? ""));
}
