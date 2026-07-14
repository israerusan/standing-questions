// The FREE matcher (DESIGN 8.2, test 4).
//
// This is the whole free tier's lead detection, and it runs on a phone with no engine. It is
// deliberately worse than the semantic matcher and deliberately not useless.
import assert from "node:assert";
import { basename, keywordLeads, significantTokens, stem } from "../src/core/keywordLeads.mjs";

const CRDT = {
	path: "Questions/CRDT.md",
	title: "Why did we drop the CRDT plan?",
	status: "open",
	links: ["Decisions/Storage.md"],
};
const ONBOARDING = {
	path: "Questions/Onboarding.md",
	title: "How long should onboarding take?",
	status: "open",
	links: [],
};

// --- a real match ---------------------------------------------------------------------
{
	const leads = keywordLeads(
		{
			path: "2026-07-14 CRDT merge benchmarks.md",
			title: "CRDT merge benchmarks",
			headings: ["Dropping the plan"],
			links: [],
		},
		[CRDT, ONBOARDING]
	);
	assert.equal(leads.length, 1);
	assert.equal(leads[0].question, "Questions/CRDT.md");
	assert.ok(leads[0].shared.includes("crdt"));
	assert.ok(leads[0].reason.startsWith("shares "), "a free lead has to say WHY — it has no score to show");
	assert.equal(leads[0].link, "2026-07-14 CRDT merge benchmarks", "the link is the SOURCE note");
}

// --- ONE shared token is not enough ------------------------------------------------------
// One word in common is a coincidence ("storage"); two is a topic. This threshold is the only
// thing standing between the free tier and a notification every time the user saves.
{
	const leads = keywordLeads(
		{ path: "Storage costs.md", title: "Storage costs", headings: [], links: [] },
		[{ path: "Q.md", title: "Why is storage slow?", status: "open" }]
	);
	assert.deepEqual(leads, [], "one shared significant token does not make a lead");
}
{
	const leads = keywordLeads(
		{ path: "Storage merge costs.md", title: "Storage merge costs", headings: [], links: [] },
		[{ path: "Q.md", title: "Why is storage merge slow?", status: "open" }]
	);
	assert.equal(leads.length, 1, "two shared significant tokens do");
}

// --- STOPWORDS DO NOT CREATE MATCHES -------------------------------------------------------
// Without a stopword list, "How should we do this?" matches "What should we do about that?" on
// {should, do} and the user is interrupted about every note they write.
{
	const leads = keywordLeads(
		{ path: "What we should do about the thing.md", title: "What we should do about the thing", headings: [], links: [] },
		[{ path: "Q.md", title: "How should we do the other thing?", status: "open" }]
	);
	assert.deepEqual(leads, [], "shared stopwords are not shared topics");
}

// --- a shared LINK is enough on its own ------------------------------------------------------
// The signal keyword matching cannot see, and semantic search does not either: the vault's own
// structure saying these two notes are about the same thing, in different words.
{
	const leads = keywordLeads(
		{ path: "Weeknotes/Week 27.md", title: "Week 27", headings: [], links: ["Decisions/Storage.md"] },
		[CRDT]
	);
	assert.equal(leads.length, 1, "no words in common at all, and it still finds the question");
	assert.deepEqual(leads[0].sharedLinks, ["Decisions/Storage.md"]);
	assert.ok(leads[0].reason.includes("both link Storage"));
}

// --- a question never matches itself ----------------------------------------------------------
{
	const leads = keywordLeads(
		{ path: CRDT.path, title: CRDT.title, headings: [], links: CRDT.links },
		[CRDT]
	);
	assert.deepEqual(leads, [], "a question is not a lead for itself");
}

// --- an ANSWERED question is never offered a lead ------------------------------------------------
{
	const leads = keywordLeads(
		{ path: "CRDT merge benchmarks.md", title: "CRDT merge benchmarks", headings: [], links: [] },
		[{ ...CRDT, status: "answered" }]
	);
	assert.deepEqual(leads, []);
}

// --- a question's own BODY counts, not just its title ----------------------------------------------
{
	const leads = keywordLeads(
		{ path: "Replication latency.md", title: "Replication latency", headings: [], links: [] },
		[{ path: "Q.md", title: "Why is it slow?", status: "open", text: "Specifically the replication latency." }]
	);
	assert.equal(leads.length, 1);
}

// --- evidence ranks: a shared link outranks shared words -------------------------------------------
{
	const leads = keywordLeads(
		{ path: "New.md", title: "CRDT merge notes", headings: [], links: ["Decisions/Storage.md"] },
		[
			{ path: "Words.md", title: "CRDT merge questions", status: "open" },
			{ path: "Link.md", title: "Something else entirely", status: "open", links: ["Decisions/Storage.md"] },
		],
		{ maxLeads: 2 }
	);
	assert.deepEqual(leads.map((lead) => lead.question), ["Link.md", "Words.md"]);
}

// --- the cap holds --------------------------------------------------------------------------------
{
	const questions = Array.from({ length: 10 }, (_, i) => ({
		path: `Q${i}.md`,
		title: "CRDT merge cost",
		status: "open",
	}));
	assert.equal(keywordLeads({ path: "N.md", title: "CRDT merge cost" }, questions, { maxLeads: 3 }).length, 3);
}

// --- tokens ----------------------------------------------------------------------------------------
assert.deepEqual(significantTokens("The merge costs are HIGH"), ["merge", "cost", "high"]);
assert.deepEqual(significantTokens("a an the of"), [], "stopwords only ⇒ no tokens");
assert.deepEqual(significantTokens("CRDT crdt CRDTs"), ["crdt"], "case and plural fold to one token");
assert.deepEqual(significantTokens("Réplication naïve"), ["réplication", "naïve"], "unicode words survive");
assert.equal(stem("merging"), "merg");
assert.equal(stem("merged"), "merg");
assert.equal(stem("policies"), "policy");
assert.equal(stem("class"), "class", "a short word is left alone");

assert.equal(basename("Folder/Sub/Note.md"), "Note");
assert.equal(basename("Note"), "Note");

// --- garbage in, nothing out -------------------------------------------------------------------------
assert.deepEqual(keywordLeads(null, [CRDT]), []);
assert.deepEqual(keywordLeads({ path: "N.md" }, null), []);
assert.deepEqual(keywordLeads({ path: "N.md", title: "x" }, [{}]), []);

console.log("ok  keyword-leads.test.mjs");
