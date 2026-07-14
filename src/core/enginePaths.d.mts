/** DESIGN 7.1 install locations, as a pure function of the host. See enginePaths.mjs. */

export const ENGINE_HOME_DIR: string;

export interface EngineHostInfo {
	/** `os.platform()`. */
	platform: string;
	/** `os.homedir()`. */
	homedir: string;
	/** `process.env`. Only LOCALAPPDATA and XDG_DATA_HOME are read. */
	env?: Record<string, string | undefined>;
}

export function engineHomeDir(host: EngineHostInfo): string;

/** `<engine home>/bin/<version>` — the directory named in the consent modal. */
export function engineInstallDir(host: EngineHostInfo, version: string): string;
