/**
 * Standing Questions' tier table (DESIGN 4.4 / 8.2). The ENGINE that reads it lives in the
 * vendored shared core (`src/shared/featureGates.mjs`); the TABLE is per-plugin and lives
 * here.
 *
 * The line: everything that makes a question a first-class object in the vault is FREE and
 * works on mobile with no engine — the index, the three states, the parent/child DAG and
 * its upward propagation, the board, and keyword-based leads. The single Pro feature is the
 * one that genuinely cannot be done heuristically: matching a note you just wrote against
 * every open question BY MEANING.
 *
 * `engine: true` means the feature needs the local semantic engine — which means desktop,
 * an installed engine, AND Pro. Those are three separate conditions and the UI must not
 * conflate them: a mobile Pro user is not being paywalled, they are being told the truth
 * about their device.
 *
 * Moving a key across `proOnly` is a product decision, not a refactor. features.test.mjs
 * pins this table so it fails the build until the change is made deliberately.
 */
export const FEATURES = Object.freeze({
	questionIndex: { proOnly: false, engine: false, label: "Question index" },
	statusTracking: { proOnly: false, engine: false, label: "Open / partial / answered states" },
	dag: { proOnly: false, engine: false, label: "Sub-questions, with status propagated upward" },
	dashboard: { proOnly: false, engine: false, label: "Question board" },
	keywordLeads: { proOnly: false, engine: false, label: "Keyword and link leads" },
	semanticLeads: { proOnly: true, engine: true, label: "Semantic lead detection" },
});
