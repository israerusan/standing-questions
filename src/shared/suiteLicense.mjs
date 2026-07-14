/**
 * The Second Read suite is licensed with ONE key that unlocks Pro in all five
 * plugins. Every plugin verifies against this exact product id and this exact
 * public key — both live here, vendored identically into all five repos by
 * `npm run sync:shared`, so a plugin can never drift into its own keyspace.
 *
 * NOTE this deliberately breaks the older portfolio rule of "one keypair per
 * product". The single shared keypair IS the product: a per-plugin keypair
 * would make a suite key impossible. The cost is blast radius — a leaked
 * customer key unlocks all five — which is why revokedLicenses.mjs is shared
 * too and is checked BEFORE the signature.
 *
 * The public half is meant to ship: it is compiled into every release. The
 * private half exists exactly once, in obsidian-plugin-core/scripts/
 * .license-suite-private.key (gitignored), and is the only thing that can mint
 * a key. Test fixtures are minted under "second-read-test" — NEVER under
 * SUITE_PRODUCT_ID (a production-signed key once sat in a public repo and
 * unlocked Pro for anyone who read it).
 */
import { verifyLicense } from "./verifyLicense.mjs";
import { isRevoked } from "./revokedLicenses.mjs";

export const SUITE_PRODUCT_ID = "second-read";
export const SUITE_LICENSE_PUBLIC_KEY = "1FRyIUDYgeRIeVzBfP5qMq5OoQElayq/lMq0YAmCtW8=";

/** The product id every committed test fixture must be signed for. Never verifies as Pro. */
export const SUITE_TEST_PRODUCT_ID = "second-read-test";

/**
 * THE ONE FUNCTION THAT DECIDES WHETHER A KEY UNLOCKS PRO. Every plugin calls this and
 * nothing else. It is vendored byte-identically into all five repos by `npm run sync:shared`.
 *
 * WHY IT LIVES HERE AND NOT IN EACH PLUGIN'S LicenseManager. The composition below —
 * revocation checked BEFORE the signature — is the whole of the suite's revocation story,
 * and it used to be hand-copied into five `src/license/LicenseManager.ts` files that no test,
 * no linter and no drift check ever compared. One plugin written (or later edited) without
 * the `isRevoked` call, and a revoked leaked key still unlocks Pro there, silently, forever.
 * With a single suite keypair the by-value denylist is the ONLY revocation mechanism we have,
 * so it cannot be the one binding that is not vendored.
 *
 * WHY THE ORDER IS NOT NEGOTIABLE. A leaked key's signature is perfectly VALID — that is what
 * makes it dangerous. Checking the signature first and the denylist second would work too,
 * but only by accident of both being consulted; checking the denylist first means a revoked
 * key is rejected on the way in, before any crypto runs, and the rejection cannot be lost to a
 * later refactor that returns early on a valid signature.
 *
 * `deps` exists so a test can prove the ORDER (see test/suite-license.test.mjs). Production
 * callers pass nothing, ever.
 */
export function verifySuiteLicense(licenseKey, deps) {
	const check = deps?.isRevoked ?? isRevoked;
	const verify = deps?.verifyLicense ?? verifyLicense;
	const key = String(licenseKey ?? "").trim();
	if (check(key)) {
		return { valid: false, error: "This key has been revoked. Contact support for a replacement." };
	}
	return verify(key, SUITE_PRODUCT_ID, SUITE_LICENSE_PUBLIC_KEY);
}
