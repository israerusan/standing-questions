import { verifySuiteLicense } from "../shared/suiteLicense.mjs";

export type { LicensePayload, LicenseVerification } from "../shared/verifyLicense.mjs";
export type { SuiteLicenseDeps } from "../shared/suiteLicense.mjs";
export { verifySuiteLicense } from "../shared/suiteLicense.mjs";

/**
 * The plugin's license entry point: a THIN RE-EXPORT of the shared suite verifier.
 *
 * `verify` is BOUND to `verifySuiteLicense` — it is not a method that reimplements it. That
 * is deliberate and load-bearing: `LicenseManager.verify === verifySuiteLicense` is asserted
 * in test/license-revocation.test.ts, which leaves no room for this file to re-grow its own
 * copy of the composition.
 *
 * WHY. The revocation-then-signature composition used to be hand-copied into all five
 * `src/license/LicenseManager.ts` files, which nothing — no test, no linter, no drift check —
 * ever compared against each other. With ONE suite keypair, the by-value denylist is the only
 * revocation mechanism there is (rotating the keypair would revoke Pro for every paying
 * customer at once, because a leaked key's signature is perfectly VALID). So one plugin
 * quietly losing its `isRevoked` call means a revoked, leaked key keeps unlocking Pro there,
 * silently, forever. The composition now lives in exactly one file, vendored byte-identically
 * by `npm run sync:shared` and guarded by src/shared/MANIFEST.sha256.
 *
 * The product id and the public key both come from the vendored shared module — never from
 * this plugin's own manifest identity — which is what makes "one key, five plugins"
 * structurally impossible to get wrong. Verification is entirely offline, and there is no
 * private key anywhere in this repo to leak.
 */
export class LicenseManager {
	/** THE decision on whether a key unlocks Pro. The shared function itself, by reference. */
	static readonly verify: typeof verifySuiteLicense = verifySuiteLicense;
}
