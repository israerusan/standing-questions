import { SUITE_PRODUCT_ID } from "./shared/suiteLicense.mjs";

/**
 * This add-on's identity, and its binding to the SUITE license.
 *
 * The two are deliberately different namespaces. `PRODUCT_ID` is the manifest id — what
 * Obsidian calls this add-on. `LICENSE_PRODUCT_ID` is what a key is signed for, and it is
 * the same string in all five Second Read add-ons, so one purchase unlocks all of them.
 * A key minted for "standing-questions" is NOT a Second Read key and must never verify;
 * that is asserted in test/license.test.mjs.
 */

/** This add-on's manifest id. NOT the license product id. */
export const PRODUCT_ID = "standing-questions";
export const PRODUCT_NAME = "Standing Questions";

/** What a license key is signed for. Shared by all five Second Read add-ons. */
export const LICENSE_PRODUCT_ID = SUITE_PRODUCT_ID; // "second-read"

export const SUITE_NAME = "Second Read";
export const PRO_NAME = "Second Read Pro";
export const PRO_PRICE_LABEL = "$29 one-time";

/**
 * Where "Unlock Pro" sends people.
 *
 * TODO(launch): this points at the suite checkout "extra", which does not exist yet, and
 * Buy Me a Coffee cannot auto-deliver a key. DESIGN 4.7 / Open Question 10.2: this must
 * move to a processor that can sign and email the key before launch. Until then the
 * checkout page must say "your key is emailed within 24 hours" — do not ship silence.
 */
export const PURCHASE_URL = "https://buymeacoffee.com/vaultspotlight";

export const PRO_TAGLINE =
	"One key unlocks Pro in all five Second Read add-ons: Note Decay, Standing Questions, Effort Index, Prior Art, and Unwritten. $29 one-time, no subscription, no account.";

/** What a free user of THIS add-on is missing, in one phrase. */
export const PRO_UNLOCK_SUMMARY =
	"semantic lead detection — new notes that may answer a question you asked months ago";

/** Contextual upsell copy, keyed by the feature the user reached for. */
export const PRO_UPSELL: Record<string, string> = {
	semanticLeads:
		"Matching a new note against your open questions by meaning is a Pro feature. Keyword leads work for free, on every device. " +
		PRO_TAGLINE,
};
