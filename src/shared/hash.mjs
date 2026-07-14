/**
 * FNV-1a, 64-bit. Synchronous, pure, dependency-free — usable in the renderer and in
 * Node, with no WebCrypto (which is async and would force every chunk id through a
 * promise) and no Node `crypto` (a static import of which compiles to a top-level
 * require() in the CJS bundle and crashes on mobile).
 *
 * This is the chunk-id function. It is NOT a security primitive: it is a content
 * fingerprint used to decide "have I already embedded this chunk?", so its only
 * requirements are determinism, speed, and a collision rate that rounds to zero at
 * vault scale. All five plugins and the sidecar must produce the SAME id for the same
 * bytes, which is why it lives here and is vendored rather than reimplemented.
 */
const ENCODER = new TextEncoder();

const OFFSET_BASIS = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/**
 * The 64-bit FNV-1a hash of a string's UTF-8 bytes, as a zero-padded 16-char
 * lowercase hex string (e.g. "9f3c1a20be44d7e1"). Stable across platforms forever —
 * changing it invalidates every stored chunk id and forces a full re-embed.
 */
export function fnv1a64(input) {
	const bytes = ENCODER.encode(String(input ?? ""));
	let hash = OFFSET_BASIS;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= BigInt(bytes[i]);
		hash = (hash * PRIME) & MASK;
	}
	return hash.toString(16).padStart(16, "0");
}
