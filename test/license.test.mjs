// The suite-key contract (DESIGN 4.6). One key unlocks five add-ons — without ever
// unlocking anything it shouldn't.
//
// FIXTURE RULE (a real incident: a production-signed vault-spotlight Pro key sat in a
// public repo and unlocked Pro for anyone who read it). No key signed for SUITE_PRODUCT_ID
// may exist in this repo, in any form, ever. The fixture below is minted at TEST TIME with
// an EPHEMERAL keypair under SUITE_TEST_PRODUCT_ID — so there is nothing to leak even if
// someone pastes the test output into an issue.
import assert from "node:assert";
import nacl from "tweetnacl";
import { verifyLicense } from "../src/shared/verifyLicense.mjs";
import {
	SUITE_LICENSE_PUBLIC_KEY,
	SUITE_PRODUCT_ID,
	SUITE_TEST_PRODUCT_ID,
} from "../src/shared/suiteLicense.mjs";
import { isRevoked, REVOKED_LICENSE_KEYS } from "../src/shared/revokedLicenses.mjs";

// The suite id read from the VENDORED shared module is what we verify against. Pinned by
// an equality assertion, not a lint rule: renaming it silently orphans every key ever sold.
assert.equal(SUITE_PRODUCT_ID, "second-read");
assert.equal(SUITE_TEST_PRODUCT_ID, "second-read-test");

// The shipped public key must be a real Ed25519 key — 32 bytes of standard base64. A
// placeholder ("<BASE64_PUBLIC_KEY>") or a truncated paste would make every customer key
// fail to verify, in all five add-ons at once, AFTER release.
assert.match(SUITE_LICENSE_PUBLIC_KEY, /^[A-Za-z0-9+/]{43}=$/, "the public key must be base64");
assert.equal(
	Buffer.from(SUITE_LICENSE_PUBLIC_KEY, "base64").length,
	32,
	"an Ed25519 public key is exactly 32 bytes"
);

const b64url = (bytes) =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const kp = nacl.sign.keyPair();
const pub = Buffer.from(kp.publicKey).toString("base64");

function mint(payload, secretKey = kp.secretKey) {
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return `${b64url(bytes)}.${b64url(nacl.sign.detached(bytes, secretKey))}`;
}

// --- a real suite key verifies ----------------------------------------------
const good = mint({ product: SUITE_PRODUCT_ID, email: "buyer@example.com", issued: "2026-07-14" });
let result = verifyLicense(good, SUITE_PRODUCT_ID, pub);
assert.ok(result.valid, "a key minted for the suite must verify");
assert.equal(result.email, "buyer@example.com");

// --- a key for ANOTHER Second Read plugin's manifest id must NOT verify ------
// Plugin identity and license identity are deliberately different namespaces. This is the
// assertion that makes "one key, five plugins" a property of the code rather than a hope.
for (const id of ["note-decay", "standing-questions", "effort-index", "prior-art", "unwritten"]) {
	const perPlugin = mint({ product: id, email: "x@y.z", issued: "2026-07-14" });
	assert.ok(
		!verifyLicense(perPlugin, SUITE_PRODUCT_ID, pub).valid,
		`a per-plugin id (${id}) must not unlock the suite`
	);
}

// --- the committed-fixture rule ---------------------------------------------
const fixture = mint({
	product: SUITE_TEST_PRODUCT_ID,
	email: "fixture@example.com",
	issued: "2026-01-01",
});
assert.equal(verifyLicense(fixture, SUITE_TEST_PRODUCT_ID, pub).valid, true);
assert.equal(
	verifyLicense(fixture, SUITE_PRODUCT_ID, pub).valid,
	false,
	"a second-read-test fixture must NOT verify as second-read"
);
assert.equal(
	verifyLicense(fixture, SUITE_PRODUCT_ID, SUITE_LICENSE_PUBLIC_KEY).valid,
	false,
	"and it must not verify against the SHIPPED public key either"
);

// --- tampering fails closed --------------------------------------------------
const [payloadPart, sigPart] = good.split(".");

const rewritten = b64url(
	new TextEncoder().encode(JSON.stringify({ product: SUITE_PRODUCT_ID, email: "evil@example.com" }))
);
assert.ok(!verifyLicense(`${rewritten}.${sigPart}`, SUITE_PRODUCT_ID, pub).valid, "rewritten payload");

const other = nacl.sign.keyPair();
assert.ok(
	!verifyLicense(good, SUITE_PRODUCT_ID, Buffer.from(other.publicKey).toString("base64")).valid,
	"a key signed by the wrong private key must not verify"
);

assert.ok(!verifyLicense("", SUITE_PRODUCT_ID, pub).valid, "an empty key is rejected");
assert.ok(!verifyLicense(`${payloadPart}.@@@`, SUITE_PRODUCT_ID, pub).valid, "bad base64 is rejected");
assert.ok(!verifyLicense(payloadPart, SUITE_PRODUCT_ID, pub).valid, "a key with no signature is rejected");

// --- revocation is BY VALUE, and ships empty ---------------------------------
// A leaked key carries a VALID signature. Rejecting it by value is the only way to kill it
// without rotating the suite keypair — which would revoke Pro for everyone who paid.
assert.deepEqual([...REVOKED_LICENSE_KEYS], [], "the revocation list ships empty");
assert.equal(isRevoked("anything"), false);
assert.equal(isRevoked(null), false, "isRevoked must not throw on a missing key");
assert.equal(isRevoked(undefined), false);

// --- there is no private key, and no minting script, in this repo -------------
// Structural, not aspirational: minting happens ONLY in obsidian-plugin-core. A plugin repo
// that cannot sign a key cannot leak one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const forbidden of [
	"scripts/generate-license.mjs",
	"scripts/generate-suite-license.mjs",
	"scripts/.license-private.key",
	"scripts/.license-suite-private.key",
	"src/license/publicKey.ts",
]) {
	assert.equal(
		fs.existsSync(path.join(root, forbidden)),
		false,
		`${forbidden} must not exist in a plugin repo — the suite key is minted only in obsidian-plugin-core`
	);
}

console.log("ok  license.test.mjs");
