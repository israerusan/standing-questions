import type { LicenseVerification } from "./verifyLicense.mjs";

export const SUITE_PRODUCT_ID: "second-read";
export const SUITE_LICENSE_PUBLIC_KEY: string;
export const SUITE_TEST_PRODUCT_ID: "second-read-test";

/** Test-only seam. Production callers never pass this. */
export interface SuiteLicenseDeps {
	isRevoked?: (licenseKey: string) => boolean;
	verifyLicense?: (licenseKey: string, product: string, publicKeyB64: string) => LicenseVerification;
}

/**
 * Revocation-then-signature, composed once for all five plugins. Each plugin's
 * `LicenseManager` is a re-export of this — never its own copy of the composition.
 */
export function verifySuiteLicense(licenseKey: string, deps?: SuiteLicenseDeps): LicenseVerification;
