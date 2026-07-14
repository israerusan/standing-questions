// The tier table (DESIGN 4.4 / 8.2). If one of these flips, someone has moved a feature
// across the paywall — a product decision, not a refactor, and it should fail the build until
// it is made deliberately.
import assert from "node:assert";
import { FEATURES } from "../src/core/features.mjs";
import { isFeatureEnabled, needsEngine, proFeatureKeys } from "../src/shared/featureGates.mjs";

// Free: a question is a first-class object in the vault, for nothing, forever, on a phone.
// This is the whole point of the free tier — it is not a demo of the Pro one.
const FREE = ["questionIndex", "statusTracking", "dag", "dashboard", "keywordLeads"];
for (const key of FREE) {
	assert.equal(FEATURES[key].proOnly, false, `${key} must stay free`);
	assert.equal(FEATURES[key].engine, false, `${key} must never need the engine — mobile runs it`);
	assert.equal(isFeatureEnabled(FEATURES, key, false), true, `${key} must run for a free user`);
	assert.equal(needsEngine(FEATURES, key), false);
}

// Pro: exactly one feature, and it is the one that genuinely cannot be done heuristically.
assert.equal(FEATURES.semanticLeads.proOnly, true);
assert.equal(FEATURES.semanticLeads.engine, true);
assert.equal(isFeatureEnabled(FEATURES, "semanticLeads", false), false);
assert.equal(isFeatureEnabled(FEATURES, "semanticLeads", true), true);
assert.equal(needsEngine(FEATURES, "semanticLeads"), true);
assert.deepEqual(proFeatureKeys(FEATURES), ["semanticLeads"]);

// Every Pro key needs the engine, and every engine key is Pro. The suite's whole line is
// "free = heuristic, Pro = semantic"; a Pro feature that needs no engine would break it, and a
// free feature that needs one would break the mobile free tier.
for (const key of Object.keys(FEATURES)) {
	assert.equal(
		FEATURES[key].proOnly,
		FEATURES[key].engine,
		`${key}: Pro and engine must be the same set (free = heuristic, Pro = semantic)`
	);
	assert.equal(typeof FEATURES[key].label, "string");
	assert.ok(FEATURES[key].label.length > 0, `${key} must have a label`);
}

// The DAG is FREE. This is the assertion that stops a future "make sub-questions Pro" from
// landing quietly: the DAG is the thing that makes questions feel like objects rather than
// tags, and a free tier without it would not be worth installing.
assert.equal(FEATURES.dag.proOnly, false);

// The table is frozen: nothing can flip a gate at runtime.
assert.ok(Object.isFrozen(FEATURES));

console.log("ok  features.test.mjs");
