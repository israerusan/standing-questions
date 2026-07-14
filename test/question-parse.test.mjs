// What makes a note a question, and where its parent comes from (DESIGN 8.2, test 1).
//
// Every case here is a real shape a vault contains. The ones that matter most are the ones
// where the WRONG behaviour is to drop the note: a typo'd status, a dangling parent, a `type`
// that is a list. A question that silently stops being a question is the worst bug this
// add-on could have — the user would never see the notice that never fired.
import assert from "node:assert";
import {
	DEFAULT_QUESTION_KEYS,
	inlineParents,
	isKnownStatus,
	linkTarget,
	parseQuestion,
	STATUSES,
} from "../src/core/questionParse.mjs";

// --- the frontmatter form ----------------------------------------------------
{
	const parsed = parseQuestion(
		{ type: "question", status: "open", parent: "[[Why did we drop CRDTs?]]" },
		"Some body text."
	);
	assert.equal(parsed.isQuestion, true);
	assert.equal(parsed.status, "open");
	assert.deepEqual(parsed.parents, ["Why did we drop CRDTs?"]);
}

// --- the inline form ---------------------------------------------------------
{
	const parsed = parseQuestion(
		{ type: "question", status: "partial" },
		"Some body.\n\nparent:: [[Storage]]\n\nMore body."
	);
	assert.equal(parsed.isQuestion, true);
	assert.equal(parsed.status, "partial");
	assert.deepEqual(parsed.parents, ["Storage"]);
}

// --- BOTH forms, and the union is de-duplicated -------------------------------
{
	const parsed = parseQuestion(
		{ type: "question", parent: ["[[A]]", "[[B]]"] },
		"parent:: [[B]], [[C]]"
	);
	assert.deepEqual(parsed.parents, ["A", "B", "C"], "frontmatter first, then inline, de-duped");
}

// --- an aliased / anchored / pathed link resolves to its TARGET ----------------
{
	const parsed = parseQuestion({ type: "question" }, "parent:: [[Questions/Storage.md|the storage one]]");
	assert.deepEqual(parsed.parents, ["Questions/Storage"], "alias and .md are stripped, the path is kept");
}
assert.equal(linkTarget("[[Note#Heading]]"), "Note");
assert.equal(linkTarget("[[Note|Alias]]"), "Note");
assert.equal(linkTarget("  Plain title  "), "Plain title");

// --- the bracketed inline-field forms Dataview users actually write ------------
assert.deepEqual(inlineParents("Text [parent:: [[A]]] more"), ["A"]);
assert.deepEqual(inlineParents("(parent:: Plain title) trailing"), ["Plain title"]);
assert.deepEqual(inlineParents("PARENT:: [[A]]"), ["A"], "the field name is case-insensitive");

// --- a `parent::` inside a code fence is NOT a parent --------------------------
// This add-on's own README contains `parent:: [[X]]` in a code block. Without the fence
// guard, pasting the README into a vault would wire the note into the DAG.
{
	const body = ["```md", "parent:: [[Not a real parent]]", "```", "", "parent:: [[Real]]"].join("\n");
	assert.deepEqual(inlineParents(body), ["Real"]);
}

// --- malformed / missing --------------------------------------------------------
{
	// A typo'd status is an OPEN question, not a non-question. Never drop the note.
	const parsed = parseQuestion({ type: "question", status: "ansered" }, "");
	assert.equal(parsed.isQuestion, true);
	assert.equal(parsed.status, "open");
	assert.equal(isKnownStatus("ansered"), false);
}
assert.equal(parseQuestion({ type: "question" }, "").status, "open", "a missing status is open");
assert.equal(parseQuestion(null, "").isQuestion, false, "no frontmatter at all must not throw");
assert.equal(parseQuestion(undefined, undefined).isQuestion, false);
assert.deepEqual(parseQuestion({ type: "question" }, "").parents, []);
assert.deepEqual(
	parseQuestion({ type: "question", parent: null }, "").parents,
	[],
	"a null parent (a real YAML shape) must not throw"
);

// --- `type` may be a list --------------------------------------------------------
assert.equal(parseQuestion({ type: ["question", "research"] }, "").isQuestion, true);
assert.equal(parseQuestion({ type: "Question" }, "").isQuestion, true, "case-insensitive");
assert.equal(parseQuestion({ type: "meeting" }, "").isQuestion, false);
assert.equal(parseQuestion({}, "parent:: [[A]]").isQuestion, false, "a parent does not make a question");

// --- the keys are configurable ---------------------------------------------------
{
	const parsed = parseQuestion(
		{ kind: "q", state: "answered", up: "[[Bigger]]" },
		"up:: [[Other]]",
		{ typeKey: "kind", questionValue: "q", statusKey: "state", parentKey: "up" }
	);
	assert.equal(parsed.isQuestion, true);
	assert.equal(parsed.status, "answered");
	assert.deepEqual(parsed.parents, ["Bigger", "Other"]);
	// And the DEFAULT keys must find nothing in that note.
	assert.equal(parseQuestion({ kind: "q" }, "up:: [[Other]]", DEFAULT_QUESTION_KEYS).isQuestion, false);
}

assert.deepEqual([...STATUSES], ["open", "partial", "answered"]);

console.log("ok  question-parse.test.mjs");
