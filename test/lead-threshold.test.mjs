// The threshold gate (DESIGN 6.5 / 8.2).
//
// This is the difference between magic and alert fatigue, and it is the only part of the lead
// pipeline the user actually feels. It is a pure function so the numbers are auditable rather
// than folklore scattered through the pipeline, and so a change to them fails a test rather
// than a customer.
import assert from "node:assert";
import { DEFAULT_LEAD_OPTIONS, selectLeads } from "../src/core/leads.mjs";

// DEFAULT_SETTINGS is seeded from these (see src/settings.ts), so pinning them here pins what
// ships. The .test.ts side asserts that the settings object really does use them.
const DEFAULT_SETTINGS = DEFAULT_LEAD_OPTIONS;

const hit = (question, score) => ({ question, questionTitle: question, link: "New note", score });

// --- the defaults are conservative, and notify-only ---------------------------------
// DESIGN 6.5 tabulates leadMinScore 0.60. We ship 0.75, deliberately: on MiniLM, 0.40–0.60 is
// where merely RELATED English text lives, so 0.60 interrupts the user about notes that share
// a subject area rather than an answer. The first false positive is charming; the fifth gets
// the add-on disabled, and a disabled add-on has no features. 0.75 is the bottom of the
// near-duplicate band.
assert.equal(DEFAULT_SETTINGS.leadMinScore, 0.75);
assert.equal(DEFAULT_SETTINGS.leadAutoAppend, false, "nothing is ever written into a note unasked");
assert.equal(DEFAULT_SETTINGS.leadAutoAppendScore, 0.85);
assert.ok(
	DEFAULT_SETTINGS.leadAutoAppendScore >= DEFAULT_SETTINGS.leadMinScore,
	"a lead too weak to mention must never be strong enough to write down"
);

// --- below the bar is not surfaced at all --------------------------------------------
{
	const selected = selectLeads([hit("Q1", 0.74), hit("Q2", 0.2)], { leadMinScore: 0.75 });
	assert.deepEqual(selected.notify, []);
	assert.deepEqual(selected.autoAppend, []);
}

// --- at the bar is surfaced (>=, not >) ------------------------------------------------
{
	const selected = selectLeads([hit("Q1", 0.75)], { leadMinScore: 0.75 });
	assert.equal(selected.notify.length, 1);
	assert.equal(selected.notify[0].question, "Q1");
}

// --- notify-only by default: NOTHING is auto-appended even at 0.99 ----------------------
{
	const selected = selectLeads([hit("Q1", 0.99)], {
		leadMinScore: DEFAULT_SETTINGS.leadMinScore,
		leadAutoAppend: DEFAULT_SETTINGS.leadAutoAppend,
		leadAutoAppendScore: DEFAULT_SETTINGS.leadAutoAppendScore,
	});
	assert.deepEqual(selected.autoAppend, [], "auto-append is opt-in, and it is off");
	assert.equal(selected.notify.length, 1);
}

// --- opted in: above the auto bar it is written, and the notice is NOT also shown ---------
// Being told about a thing that has already been done is just noise.
{
	const selected = selectLeads([hit("Q1", 0.9), hit("Q2", 0.8)], {
		leadMinScore: 0.75,
		leadAutoAppend: true,
		leadAutoAppendScore: 0.85,
	});
	assert.deepEqual(selected.autoAppend.map((lead) => lead.question), ["Q1"]);
	assert.deepEqual(selected.notify.map((lead) => lead.question), ["Q2"], "0.80 is above the bar but below the auto bar");
}

// --- one lead per question, best chunk wins -----------------------------------------------
// A note that hits three chunks of the same question is ONE lead, not three notices.
{
	const selected = selectLeads([hit("Q1", 0.78), hit("Q1", 0.91), hit("Q1", 0.8)], {
		leadMinScore: 0.75,
	});
	assert.equal(selected.notify.length, 1);
	assert.equal(selected.notify[0].score, 0.91, "the strongest passage represents the lead");
}

// --- the cap holds, and the strongest survive ----------------------------------------------
{
	const hits = [hit("Q1", 0.8), hit("Q2", 0.95), hit("Q3", 0.9), hit("Q4", 0.85)];
	const selected = selectLeads(hits, { leadMinScore: 0.75, maxLeads: 2 });
	assert.deepEqual(selected.notify.map((lead) => lead.question), ["Q2", "Q3"]);
}

// --- an excluded question is never surfaced --------------------------------------------------
// A question that already links the note has already been told about it. Re-offering it is the
// single most annoying thing this add-on could do.
{
	const selected = selectLeads([hit("Q1", 0.9), hit("Q2", 0.9)], {
		leadMinScore: 0.75,
		excludeQuestions: ["Q1"],
	});
	assert.deepEqual(selected.notify.map((lead) => lead.question), ["Q2"]);
}

// --- a keyword lead carries no score, and is never auto-appended --------------------------------
// "Two words in common" is not evidence worth writing into someone's note unasked.
{
	const keyword = { question: "Q1", questionTitle: "Q1", link: "New note", reason: "shares crdt, merge" };
	const selected = selectLeads([keyword], {
		leadMinScore: 0.9,
		leadAutoAppend: true,
		leadAutoAppendScore: 0.5,
	});
	assert.equal(selected.notify.length, 1, "a scoreless lead is not filtered by a cosine threshold");
	assert.deepEqual(selected.autoAppend, [], "and it can never be auto-appended");
}

// --- a scored hit beats a scoreless one for the same question ------------------------------------
{
	const keyword = { question: "Q1", link: "New note", reason: "shares crdt" };
	const selected = selectLeads([keyword, hit("Q1", 0.8)], { leadMinScore: 0.75 });
	assert.equal(selected.notify.length, 1);
	assert.equal(selected.notify[0].score, 0.8, "the semantic hit represents the lead, not the keyword one");
}

// --- garbage in, nothing out ---------------------------------------------------------------------
assert.deepEqual(selectLeads(null, {}).notify, []);
assert.deepEqual(selectLeads([null, {}, { question: "" }], {}).notify, []);
assert.deepEqual(selectLeads([hit("Q1", 0.9)], { maxLeads: 0 }).notify, []);

console.log("ok  lead-threshold.test.mjs");
