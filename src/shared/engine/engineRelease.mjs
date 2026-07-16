/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate from a real engine release:
 *     node scripts/pin-engine.mjs sidecar-v0.1.0
 * then `npm run sync:shared` in every plugin repo.
 *
 * These hashes are baked into main.js at build time and the downloaded bytes are
 * checked against them BEFORE the exec bit is set (DESIGN 7.3 step 4). Changing a
 * value here by hand defeats the only integrity check in the install flow.
 */

/** Placeholder value written by the unpinned seed. A real hash is never all zeros. */
export const PLACEHOLDER_SHA256 = "0000000000000000000000000000000000000000000000000000000000000000";

/** True once scripts/pin-engine.mjs has run against a published release. */
export const ENGINE_RELEASE_PINNED = true;

/** The engine version this plugin build expects. `installed.version !== ENGINE_VERSION` ⇒ offer "Update engine". */
export const ENGINE_VERSION = "0.1.0";

/** The git tag the assets hang off. Engine tags are `sidecar-v<version>`; plugin tags are bare X.Y.Z (DESIGN 7.4). */
export const ENGINE_RELEASE_TAG = "sidecar-v0.1.0";

/** What `health` must report for the index to be readable. A potion vector and a MiniLM vector are not comparable (DESIGN 6.5). */
export const ENGINE_MODEL = "all-MiniLM-L6-v2";
export const ENGINE_DIM = 384;

/** SHA-256 of each release asset, keyed by target. */
export const ENGINE_ASSET_SHA256 = Object.freeze({
	"win-x64": "c1746b74e42da259a879f668b627cd855fa2c49cd1dc07c8730b1eb59d0a3be4",
	"macos-arm64": "1175bfc36600a6b230a66e5b8e4955ddad25f33d0e979156fb74f061affad8ce",
	"linux-x64": "1acd5ee14db5894c5c4d2420af8c9ea9721a42861736756a69807ed75f392359",
});

/** True when `sha256` is the unpinned seed value and must not be trusted. */
export function isPlaceholderSha256(sha256) {
	return String(sha256 ?? "").toLowerCase() === PLACEHOLDER_SHA256;
}
