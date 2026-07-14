/**
 * The feature-gate ENGINE. Pure, table-parameterized, no `obsidian` import — so the
 * TypeScript UI and the Node test suite read the same truth and can never drift.
 *
 * The tables themselves do NOT live here: each plugin owns its own FEATURES table in
 * `src/core/features.mjs`, because what is free and what is Pro is a per-plugin
 * product decision. Only the mechanics are shared, and every function takes the table
 * as its first argument.
 *
 * A gate entry is `{ proOnly: boolean, engine?: boolean, freeLimit?: number, label: string }`:
 * - `proOnly` — needs a valid Second Read key.
 * - `engine`  — needs the semantic sidecar (and therefore desktop + an installed engine).
 *               A Pro user on mobile still cannot use an `engine: true` feature.
 * - `freeLimit` — the free-tier count allowance; absent means uncapped.
 *
 * Unknown keys are FREE. That is deliberate: a typo in a gate lookup must degrade to
 * "the user gets the feature", never to "a paying customer is locked out".
 */

/** True when `key` is available at the given entitlement. Unknown keys are free. */
export function isFeatureEnabled(table, key, isPro) {
	const gate = table ? table[key] : undefined;
	if (!gate) return true;
	return gate.proOnly ? isPro === true : true;
}

/** The Pro-only keys of a table, in declaration order. */
export function proFeatureKeys(table) {
	if (!table) return [];
	return Object.keys(table).filter((key) => table[key].proOnly === true);
}

/** True when a feature needs the semantic engine (and therefore desktop + an installed engine). */
export function needsEngine(table, key) {
	const gate = table ? table[key] : undefined;
	return gate ? gate.engine === true : false;
}

/** The free-tier count allowance for a feature, or Infinity when uncapped. */
export function featureFreeLimit(table, key) {
	const gate = table ? table[key] : undefined;
	return gate && typeof gate.freeLimit === "number" ? gate.freeLimit : Infinity;
}

/** True if a free user may still add another of `key` at the given count. Pro is uncapped. */
export function withinFreeLimit(table, key, count, isPro) {
	if (isPro === true) return true;
	return count < featureFreeLimit(table, key);
}
