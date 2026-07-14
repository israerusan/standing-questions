import { verifyLicense, type LicenseVerification } from "../shared/verifyLicense.mjs";
import { SUITE_LICENSE_PUBLIC_KEY, SUITE_PRODUCT_ID } from "../shared/suiteLicense.mjs";
import { isRevoked } from "../shared/revokedLicenses.mjs";

export type { LicensePayload, LicenseVerification } from "../shared/verifyLicense.mjs";

/**
 * Thin binding over the shared verifier. One Second Read key unlocks Pro in all five
 * add-ons, so the product id and the public key both come from the vendored shared module
 * — never from this plugin's own product.ts identity. That is what makes "one key, five
 * plugins" structurally impossible to get wrong: there is no per-plugin keyspace to drift
 * into, and no private key anywhere in this repo to leak.
 *
 * Revocation is checked BEFORE the signature. A key that has leaked publicly still carries
 * a VALID signature — the only way to kill it without rotating the suite keypair (which
 * would revoke Pro for every paying customer at once) is to reject it by value.
 */
export class LicenseManager {
	static verify(licenseKey: string): LicenseVerification {
		const key = String(licenseKey ?? "").trim();
		if (isRevoked(key)) {
			return { valid: false, error: "This key has been revoked. Contact support for a replacement." };
		}
		return verifyLicense(key, SUITE_PRODUCT_ID, SUITE_LICENSE_PUBLIC_KEY);
	}
}
