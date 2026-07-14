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
export const SUITE_PRODUCT_ID = "second-read";
export const SUITE_LICENSE_PUBLIC_KEY = "1FRyIUDYgeRIeVzBfP5qMq5OoQElayq/lMq0YAmCtW8=";

/** The product id every committed test fixture must be signed for. Never verifies as Pro. */
export const SUITE_TEST_PRODUCT_ID = "second-read-test";
