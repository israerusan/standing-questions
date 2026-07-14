// The `## Leads` writer (DESIGN 8.2, test 3).
//
// This function is handed to `Vault.process`, which means its return value BECOMES the user's
// note. Every assertion here is really the same assertion: it must not lose anything.
import assert from "node:assert";
import { appendLead, formatLead, hasLead, LEADS_HEADING } from "../src/core/leads.mjs";

const lead = {
	question: "Questions/CRDT.md",
	link: "2026-07-14 Storage benchmarks",
	score: 0.71,
	preview: "…the merge cost scaled with the number of replicas…",
};

// --- creates the section when it is absent ---------------------------------------
{
	const before = "---\ntype: question\n---\n\n# Why did we drop CRDTs?\n\nWe never wrote it down.\n";
	const after = appendLead(before, lead);
	assert.ok(after.startsWith(before.trimEnd()), "everything that was there is still there, in order");
	assert.ok(after.includes(LEADS_HEADING));
	assert.ok(after.includes("- [[2026-07-14 Storage benchmarks]] — 0.71 · \"…the merge cost scaled"));
	assert.ok(after.endsWith("\n"), "the trailing newline survives");
}

// --- appends under an existing section --------------------------------------------
{
	const before = ["# Q", "", "## Leads", "", "- [[An earlier lead]] — 0.80", ""].join("\n");
	const after = appendLead(before, lead);
	const lines = after.split("\n");
	const heading = lines.indexOf("## Leads");
	assert.ok(heading !== -1);
	assert.equal(lines[heading + 2], "- [[An earlier lead]] — 0.80", "the existing lead is untouched");
	assert.ok(lines[heading + 3].startsWith("- [[2026-07-14 Storage benchmarks]]"), "the new one follows it");
	assert.equal(after.split("## Leads").length - 1, 1, "the section is not duplicated");
}

// --- IDEMPOTENT: the same link is never appended twice --------------------------------
// The pipeline runs on every modify of every note. Without this, a note the user keeps
// editing would accrete the same lead line for ever.
{
	const once = appendLead("# Q\n", lead);
	const twice = appendLead(once, lead);
	assert.equal(twice, once, "appending the same lead again is a byte-for-byte no-op");

	// Even with a different score and preview — it is the LINK that identifies the lead.
	const again = appendLead(once, { ...lead, score: 0.99, preview: "different passage" });
	assert.equal(again, once);
}

// --- ...and it recognises the link however the user's note spells it ---------------------
{
	const existing = "# Q\n\n## Leads\n\n- [[Notes/Storage benchmarks|the benchmarks]] — 0.80\n";
	assert.equal(hasLead(existing, "Storage benchmarks"), true, "an alias and a folder path still match");
	assert.equal(appendLead(existing, { link: "Storage benchmarks", score: 0.9 }), existing);
	assert.equal(hasLead(existing, "Something else"), false);
}

// --- content AFTER the section is preserved ----------------------------------------------
// The Leads section is a SECTION, not "the rest of the file". Getting this wrong silently
// deletes the user's own notes below it.
{
	const before = [
		"# Q",
		"",
		"## Leads",
		"",
		"- [[Old]] — 0.80",
		"",
		"## Notes",
		"",
		"Something I wrote by hand.",
		"",
		"## Decision",
		"",
		"We chose X because Y.",
		"",
	].join("\n");
	const after = appendLead(before, lead);

	assert.ok(after.includes("Something I wrote by hand."));
	assert.ok(after.includes("We chose X because Y."));
	assert.ok(
		after.indexOf("2026-07-14 Storage benchmarks") < after.indexOf("## Notes"),
		"the new lead lands inside the Leads section, not at the end of the file"
	);
	assert.equal(after.split("\n").length, before.split("\n").length + 1, "exactly one line was added");
	// The blank line the user left between the section and the next heading is still there.
	const lines = after.split("\n");
	assert.equal(lines[lines.indexOf("## Notes") - 1], "");
}

// --- a lead in the LAST section still lands inside it -----------------------------------
{
	const before = "# Q\n\n## Leads\n\n- [[Old]] — 0.80\n";
	const after = appendLead(before, lead);
	assert.ok(after.trimEnd().endsWith('"…the merge cost scaled with the number of replicas…"'));
}

// --- an empty note -----------------------------------------------------------------------
assert.equal(appendLead("", { link: "X", score: 0.9 }), "## Leads\n\n- [[X]] — 0.90\n");

// --- a lead with no link is not a lead ----------------------------------------------------
assert.equal(appendLead("# Q\n", { link: "  " }), "# Q\n");

// --- formatting ---------------------------------------------------------------------------
assert.equal(formatLead({ link: "X", score: 0.7 }), "- [[X]] — 0.70");
assert.equal(
	formatLead({ link: "X", reason: "shares crdt, merge" }),
	"- [[X]] — shares crdt, merge",
	"a free keyword lead says WHY, since it has no score to show"
);
assert.equal(formatLead({ link: "X" }), "- [[X]]");
assert.equal(
	formatLead({ link: "X", score: 0.5, preview: "  a  b\nc  " }),
	'- [[X]] — 0.50 · "a b c"',
	"whitespace in the quoted passage is collapsed, so a lead is always one line"
);
{
	// A quote inside the preview would break out of the quoted string.
	const formatted = formatLead({ link: "X", score: 0.5, preview: 'he said "no"' });
	assert.equal(formatted, '- [[X]] — 0.50 · "he said no"');
}
{
	const long = formatLead({ link: "X", score: 0.5, preview: "w ".repeat(200) });
	assert.ok(long.length < 160, "a preview is truncated, so a lead never becomes a paragraph");
	assert.ok(long.includes("…"));
}

console.log("ok  leads-append.test.mjs");
