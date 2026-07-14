import { Platform } from "obsidian";
import type { EngineHostInfo } from "./core/enginePaths.d.mts";

/**
 * The three facts about the machine that the consent modal needs in order to name the exact
 * directory an executable is about to be written to.
 *
 * NO STATIC NODE IMPORT. `import os from "os"` compiles to a TOP-LEVEL `require()` in the CJS
 * bundle and crashes every mobile user on load, whatever `isDesktopOnly` says. Node is reached
 * for through `window.require` inside a `Platform.isDesktop` guard, in a try/catch, and every
 * caller handles null by degrading — which is the pattern `eslint-plugin-obsidianmd`'s
 * `no-nodejs-modules` rule explicitly blesses, and the reason the free tier of this add-on
 * runs on a phone.
 */
export function nodeHostInfo(): EngineHostInfo | null {
	if (!Platform.isDesktop) return null;
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		if (typeof req !== "function") return null;
		const os = req("os") as { platform(): string; homedir(): string };
		const proc = req("process") as { env: Record<string, string | undefined> };
		return { platform: os.platform(), homedir: os.homedir(), env: proc.env };
	} catch {
		return null;
	}
}
