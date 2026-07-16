/**
 * (platform, arch) -> what to download, from where, and the SHA-256 it must have.
 * PURE — no Node, no `obsidian`. EngineHost calls this behind its desktop guard
 * and then does nothing but obey the plan (DESIGN 7.3 steps 1–2).
 *
 * `platform` and `arch` are `os.platform()` / `os.arch()` values, NOT anything
 * sniffed from the user agent (the `platform` lint rule bans UA sniffing; `os.*`
 * inside a Platform.isDesktop guard is exactly what the precedent plugins do).
 */
import {
	ENGINE_ASSET_SHA256,
	ENGINE_RELEASE_PINNED,
	ENGINE_RELEASE_TAG,
	ENGINE_VERSION,
	isPlaceholderSha256,
} from "./engineRelease.mjs";

export const ENGINE_REPO = "israerusan/second-read-engine";
export const ENGINE_RELEASE_BASE = "https://github.com/israerusan/second-read-engine/releases/download";

/** Engine tags are `sidecar-v<version>` — distinct from plugin tags, which are bare X.Y.Z (DESIGN 7.4). */
export const ENGINE_TAG_PREFIX = "sidecar-v";

/**
 * The (platform, arch) pairs the sidecar CI builds AND publishes a checksum for. macos-x64
 * (Intel Mac) is deliberately absent as of engine 0.1.0: it can only build on GitHub's
 * retiring macos-13 runner, which now queues for hours or never starts, so shipping it
 * blocked the whole release on a platform Apple has not sold since ~2023. `resolveTarget`
 * still MAPS darwin/x64 to "macos-x64" so an Intel Mac gets the specific "no build for your
 * platform, set a BYO path or use free features" message (via installPlan's refusal), rather
 * than a silent generic null. Re-add it here when a later engine release ships that binary.
 */
export const SUPPORTED_TARGETS = Object.freeze(["win-x64", "macos-arm64", "linux-x64"]);

/**
 * Hosts a download redirect may land on. GitHub 302s a release asset to its object
 * store, and the object-store hostname has changed once already, so the list is
 * explicit and anything outside it aborts the download (DESIGN 7.3 step 3).
 */
export const ALLOWED_DOWNLOAD_HOSTS = Object.freeze([
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
]);

/** The platform is real but we ship no binary for it. Carries the sidecar's UNSUPPORTED code. */
export class UnsupportedPlatformError extends Error {
	constructor(platform, arch) {
		super(
			`The semantic engine has no build for ${String(platform)}/${String(arch)}. ` +
				"Set a path to an existing engine in settings, or use the add-on's free features."
		);
		this.name = "UnsupportedPlatformError";
		this.code = "UNSUPPORTED";
		this.platform = String(platform);
		this.arch = String(arch);
	}
}

/** The pinned release is a placeholder — refuse to download rather than run unverified bytes. */
export class UnpinnedReleaseError extends Error {
	constructor(target) {
		super(
			"This build has no pinned checksum for the engine, so it will not download one. " +
				"Report this — it is a release-process bug."
		);
		this.name = "UnpinnedReleaseError";
		this.code = "UNSUPPORTED";
		this.target = String(target);
	}
}

/** `os.platform()` + `os.arch()` -> target id, or null when we ship nothing for it. */
export function resolveTarget(platform, arch) {
	const p = String(platform ?? "");
	const a = String(arch ?? "");
	if (p === "win32" && a === "x64") return "win-x64";
	if (p === "darwin" && a === "arm64") return "macos-arm64";
	if (p === "darwin" && a === "x64") return "macos-x64";
	if (p === "linux" && a === "x64") return "linux-x64";
	return null;
}

export function isSupportedTarget(target) {
	return SUPPORTED_TARGETS.includes(String(target));
}

/** The release tag for a version. */
export function releaseTag(version) {
	return ENGINE_TAG_PREFIX + String(version);
}

/** The single downloadable artifact: a onedir build, zipped (DESIGN 1, item 1). */
export function assetName(target) {
	return `embed-sidecar-${target}.zip`;
}

/** The executable inside the extracted onedir. */
export function executableName(target) {
	return String(target).startsWith("win-") ? "embed-sidecar.exe" : "embed-sidecar";
}

/**
 * A URL is fetchable only if it is HTTPS, on the allowlist, and on the default port. Parsed
 * with a regex rather than `URL` so this module needs no host globals at all — and so a
 * scheme-relative or userinfo-bearing URL (`https://github.com@evil.test/x`) cannot smuggle a
 * host past us: `@` is not in the allowed hostname character class.
 *
 * No port is accepted, not even an explicit `:443`. GitHub does not serve release assets on
 * anything else, so `https://github.com:1337/...` is not a URL we could ever legitimately be
 * redirected to — and every extra shape the allowlist accepts is one more thing to reason
 * about when the question is "can this download point somewhere we did not intend".
 */
export function isAllowedDownloadUrl(url) {
	const m = /^https:\/\/([A-Za-z0-9.-]+)(\/|$)/.exec(String(url ?? ""));
	if (!m) return false;
	return ALLOWED_DOWNLOAD_HOSTS.includes(m[1].toLowerCase());
}

/**
 * Everything the installer needs, and nothing it may decide for itself.
 *
 * Throws UnsupportedPlatformError for a target we do not build, and
 * UnpinnedReleaseError when the baked-in checksum is still the placeholder — a
 * download with no real checksum to verify against is a download we refuse to make.
 *
 * `release` is injectable purely so the tests can drive it without regenerating
 * engineRelease.mjs; production always passes nothing.
 */
export function installPlan(target, version, release) {
	const t = String(target ?? "");
	if (!isSupportedTarget(t)) throw new UnsupportedPlatformError(t, "");

	const rel = release ?? {
		version: ENGINE_VERSION,
		tag: ENGINE_RELEASE_TAG,
		pinned: ENGINE_RELEASE_PINNED,
		sha256: ENGINE_ASSET_SHA256,
	};
	const v = String(version ?? rel.version);
	const tag = rel.tag && String(rel.version) === v ? String(rel.tag) : releaseTag(v);
	const sha256 = String((rel.sha256 ?? {})[t] ?? "");

	if (rel.pinned === false || sha256.length !== 64 || isPlaceholderSha256(sha256)) {
		throw new UnpinnedReleaseError(t);
	}

	const asset = assetName(t);
	return Object.freeze({
		target: t,
		version: v,
		tag,
		assetName: asset,
		url: `${ENGINE_RELEASE_BASE}/${tag}/${asset}`,
		sha256: sha256.toLowerCase(),
		executable: executableName(t),
	});
}

/**
 * The plan for the machine we are running on. Returns null (rather than throwing)
 * when the platform is unsupported, because the settings tab renders that as the
 * BYO-path escape hatch and not as an error.
 */
export function planForHost(platform, arch, version, release) {
	const target = resolveTarget(platform, arch);
	if (!target) return null;
	return installPlan(target, version ?? ENGINE_VERSION, release);
}
