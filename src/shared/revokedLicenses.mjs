/**
 * Keys revoked by VALUE. Ships empty.
 *
 * Why this exists before there is anything to revoke: with a single suite keypair,
 * one leaked customer key unlocks Pro in all five add-ons. The only other way to
 * kill a leaked key is to rotate the keypair — which invalidates the key of every
 * customer who paid, because a signature is a signature and a leaked key's is
 * perfectly VALID. So the escape hatch has to be a by-value denylist, it has to be
 * checked BEFORE the signature, and it has to be shipping in v1.0.0 of every plugin
 * — a denylist added in a later release cannot revoke anything on an installation
 * that never updates.
 *
 * If a key leaks (a fixture committed by mistake, a customer publishing theirs):
 * add it here, run `npm run sync:shared` in all five repos, release a patch.
 * DO NOT rotate the suite keypair.
 */
export const REVOKED_LICENSE_KEYS = Object.freeze([]);

const set = new Set(REVOKED_LICENSE_KEYS);

/** True when this exact key string has been revoked. Checked before the signature. */
export function isRevoked(licenseKey) {
	return set.has(String(licenseKey ?? "").trim());
}
