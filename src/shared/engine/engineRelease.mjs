/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate from a real engine release:
 *     node scripts/pin-engine.mjs sidecar-v1.0.0
 * then `npm run sync:shared` in every plugin repo.
 *
 * ==========================================================================
 *  THIS IS THE UNPINNED SEED. EVERY HASH BELOW IS A PLACEHOLDER (64 zeros).
 *  ENGINE_RELEASE_PINNED is false, and EngineHost REFUSES TO DOWNLOAD while
 *  it is false — a build that shipped with these values would be a build that
 *  downloads and executes an unverified binary, so it fails closed instead.
 * ==========================================================================
 *
 * The pinned SHA-256 is the whole security story of the install flow: it is
 * baked into main.js at build time and the downloaded bytes are checked against
 * it BEFORE the exec bit is set (DESIGN 7.3 step 4). Neither MCP Tools nor
 * Zotero Integration does this.
 */

/** Placeholder value written by the seed. A real hash is never all zeros. */
export const PLACEHOLDER_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

/** False until scripts/pin-engine.mjs has run against a published release. */
export const ENGINE_RELEASE_PINNED = false;

/** The engine version this plugin build expects. `installed.version !== ENGINE_VERSION` ⇒ offer "Update engine". */
export const ENGINE_VERSION = "0.0.0-dev";

/** The git tag the assets hang off. Engine tags are `sidecar-v<version>`; plugin tags are bare X.Y.Z (DESIGN 7.4). */
export const ENGINE_RELEASE_TAG = "sidecar-v0.0.0-dev";

/** What `health` must report for the index to be readable. A potion vector and a MiniLM vector are not comparable (DESIGN 6.5). */
export const ENGINE_MODEL = "all-MiniLM-L6-v2";
export const ENGINE_DIM = 384;

/** SHA-256 of each release asset, keyed by target. */
export const ENGINE_ASSET_SHA256 = Object.freeze({
	"win-x64": "0000000000000000000000000000000000000000000000000000000000000000",
	"macos-arm64": "0000000000000000000000000000000000000000000000000000000000000000",
	"macos-x64": "0000000000000000000000000000000000000000000000000000000000000000",
	"linux-x64": "0000000000000000000000000000000000000000000000000000000000000000",
});

/** True when `sha256` is the unpinned seed value and must not be trusted. */
export function isPlaceholderSha256(sha256) {
	return String(sha256 ?? "").toLowerCase() === PLACEHOLDER_SHA256;
}
