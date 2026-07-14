// The plugin's OWN verify path must reject a revoked key.
//
// license.test.mjs exercises `verifyLicense` (the crypto) directly, and never once calls
// LicenseManager — so it would stay green if this plugin's LicenseManager dropped the
// `isRevoked` call and shipped a revoked, leaked key straight through to Pro. With a single
// suite keypair the by-value denylist is the ONLY revocation mechanism there is, so the one
// binding that must never drift is exactly the one nothing was testing. This file tests the
// binding: the code path main.ts actually calls, LicenseManager.verify.
//
// FIXTURE RULE. No key signed for SUITE_PRODUCT_ID may exist in this repo, in any form, ever
// (a production-signed key once sat in a public repo and unlocked Pro for anyone who read it).
// The key below is minted at TEST TIME, under SUITE_TEST_PRODUCT_ID, with an EPHEMERAL keypair
// that dies with the process. Its signature is nonetheless a REAL Ed25519 signature, checked by
// the REAL shared `verifyLicense`, against the ephemeral public key handed to the verifier
// through the shared module's documented test seam (`deps`) — which is the only way to hold a
// key that genuinely verifies without a private key in this repo. That matters: a "revoked" key
// with a junk signature would be rejected by the signature check alone, and the test would pass
// with the revocation branch never running. Here, the key is proven to unlock Pro FIRST (block
// 2), so the rejection in block 3 can only come from revocation.
import assert from "node:assert";
import nacl from "tweetnacl";
import { LicenseManager } from "../src/license/LicenseManager";
import { verifySuiteLicense, SUITE_TEST_PRODUCT_ID } from "../src/shared/suiteLicense.mjs";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import type { LicenseVerification, SuiteLicenseDeps } from "../src/license/LicenseManager";

// --- 1. the plugin does not own a copy of the composition ---------------------------------
// Not a style assertion. This is the drift check that did not exist: `verify` must BE the
// shared function, which leaves nowhere for a hand-rolled revoke-then-verify to live.
assert.equal(
	LicenseManager.verify,
	verifySuiteLicense,
	"LicenseManager.verify must BE the shared verifySuiteLicense, not this plugin's own copy of " +
		"revoke-then-verify — that hand-rolled composition is what drifts, and the drift is silent"
);

const b64url = (bytes: Uint8Array) =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const ephemeral = nacl.sign.keyPair();
const ephemeralPublicKey = Buffer.from(ephemeral.publicKey).toString("base64");

function mint(payload: Record<string, string>): string {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return `${b64url(bytes)}.${b64url(nacl.sign.detached(bytes, ephemeral.secretKey))}`;
}

/** A key whose signature is genuinely, cryptographically valid — a leaked customer key. */
const leaked = mint({
	product: SUITE_TEST_PRODUCT_ID,
	email: "buyer@example.com",
	issued: "2026-07-14",
});

// The trust anchor is swapped for the ephemeral one (there is no suite private key in this
// repo, and there must never be). The Ed25519 check itself is the real shared implementation.
let signatureChecks = 0;
const trustEphemeral: SuiteLicenseDeps = {
	verifyLicense: (candidate) => {
		signatureChecks++;
		return verifyLicense(candidate, SUITE_TEST_PRODUCT_ID, ephemeralPublicKey);
	},
};

// --- 2. control: this key really does unlock Pro through the plugin's verify path ----------
// Without this, block 3 proves nothing: any junk string is "rejected".
const live: LicenseVerification = LicenseManager.verify(leaked, trustEphemeral);
assert.equal(live.valid, true, "the fixture must unlock Pro before it is revoked, or block 3 is vacuous");
assert.equal(live.email, "buyer@example.com");
assert.equal(signatureChecks, 1, "the signature was actually checked");

// --- 3. revoked BY VALUE: the same key, now on the denylist, must NOT unlock Pro -----------
const denylisted: SuiteLicenseDeps = { ...trustEphemeral, isRevoked: (key) => key === leaked };

const rejected = LicenseManager.verify(leaked, denylisted);
assert.equal(rejected.valid, false, "a revoked key must not unlock Pro — its signature is still VALID");
assert.equal(rejected.email, undefined, "a revoked key must not carry an entitlement email either");
assert.match(rejected.error ?? "", /revoked/i);

// The denylist is consulted BEFORE the crypto: a revoked key is turned away on the way in, so
// the rejection cannot be lost to a later refactor that returns early on a valid signature.
assert.equal(signatureChecks, 1, "revocation must short-circuit BEFORE the signature is verified");

// Revocation is by value on the TRIMMED key — a pasted key with stray whitespace is the same key.
assert.equal(
	LicenseManager.verify(`  ${leaked}\n`, denylisted).valid,
	false,
	"whitespace around a revoked key must not smuggle it past the denylist"
);
assert.equal(signatureChecks, 1);

// --- 4. and the production path (no deps) trusts only the suite key ------------------------
// Proof the seam above is a seam and not a backdoor: with nothing injected, the ephemeral key
// is verified against the shipped suite public key, and fails.
assert.equal(
	LicenseManager.verify(leaked).valid,
	false,
	"a key signed by anything other than the suite private key must never unlock Pro"
);
assert.equal(LicenseManager.verify("").valid, false, "an empty key is not a licence");

console.log("ok  license-revocation.test.ts (revoked key rejected by the plugin's own verify path)");
