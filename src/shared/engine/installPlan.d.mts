/** (platform, arch) -> asset, URL and expected SHA-256. Pure — see installPlan.mjs. */

export type EngineTarget = "win-x64" | "macos-arm64" | "macos-x64" | "linux-x64";

export const ENGINE_REPO: string;
export const ENGINE_RELEASE_BASE: string;
export const ENGINE_TAG_PREFIX: string;
export const SUPPORTED_TARGETS: readonly EngineTarget[];
export const ALLOWED_DOWNLOAD_HOSTS: readonly string[];

export class UnsupportedPlatformError extends Error {
	constructor(platform: string, arch: string);
	readonly code: "UNSUPPORTED";
	readonly platform: string;
	readonly arch: string;
}

export class UnpinnedReleaseError extends Error {
	constructor(target: string);
	readonly code: "UNSUPPORTED";
	readonly target: string;
}

/** `os.platform()` + `os.arch()` -> target, or null when no build exists. */
export function resolveTarget(platform: string, arch: string): EngineTarget | null;
export function isSupportedTarget(target: string): boolean;
export function releaseTag(version: string): string;
export function assetName(target: EngineTarget | string): string;
export function executableName(target: EngineTarget | string): string;
/** HTTPS + host allowlist. Every redirect hop is re-checked with this. */
export function isAllowedDownloadUrl(url: string): boolean;

export interface EngineReleaseData {
	version: string;
	tag?: string;
	pinned?: boolean;
	sha256: Record<string, string>;
}

export interface InstallPlan {
	readonly target: EngineTarget;
	readonly version: string;
	readonly tag: string;
	readonly assetName: string;
	readonly url: string;
	/** 64 lowercase hex chars. Verified before the exec bit is set. */
	readonly sha256: string;
	readonly executable: string;
}

/** Throws UnsupportedPlatformError / UnpinnedReleaseError. `release` is a test seam. */
export function installPlan(
	target: EngineTarget | string,
	version?: string,
	release?: EngineReleaseData
): InstallPlan;

/** Null when the platform is unsupported — the settings tab shows the BYO-path setting instead. */
export function planForHost(
	platform: string,
	arch: string,
	version?: string,
	release?: EngineReleaseData
): InstallPlan | null;
