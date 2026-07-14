// The DAG and upward propagation (DESIGN 8.2, test 2).
//
// The load-bearing assertion in this file is the CYCLE one. `parent::` is user-authored text,
// so `A -> B -> A` is one typo away, and a naive post-order walk over it does not return —
// Obsidian would hang on load, on the user's own vault, with no way to tell what did it.
import assert from "node:assert";
import {
	buildDag,
	propagateStatus,
	statusChanges,
	statusFromChildren,
	treeOrder,
} from "../src/core/questionDag.mjs";

const node = (id, status, parents = []) => ({ id, title: id, status, parents });

/** The propagated status of every node, in one call. */
function propagate(nodes) {
	const dag = buildDag(nodes);
	return { dag, statuses: propagateStatus(nodes, dag) };
}

// --- all children answered => the parent is answered ---------------------------
{
	const nodes = [
		node("R", "open"),
		node("A", "answered", ["R"]),
		node("B", "answered", ["R"]),
	];
	const { statuses } = propagate(nodes);
	assert.equal(statuses.get("R"), "answered", "every sub-question answered ⇒ the parent is answered");
	assert.equal(statuses.get("A"), "answered");
}

// --- some answered, some open => partial ---------------------------------------
{
	const nodes = [node("R", "open"), node("A", "answered", ["R"]), node("B", "open", ["R"])];
	const { statuses } = propagate(nodes);
	assert.equal(statuses.get("R"), "partial");
}

// --- no children answered => the parent is untouched ----------------------------
{
	const nodes = [node("R", "open"), node("A", "open", ["R"])];
	assert.equal(propagate(nodes).statuses.get("R"), "open");
}

// --- a partial child alone is enough to move an open parent to partial -----------
{
	const nodes = [node("R", "open"), node("A", "partial", ["R"])];
	assert.equal(propagate(nodes).statuses.get("R"), "partial");
}

// --- propagation never moves a question BACKWARDS ---------------------------------
// A human who wrote `status: answered` on a parent meant it. A sub-question they never got
// round to closing must not silently reopen their answer.
{
	const nodes = [node("R", "answered"), node("A", "open", ["R"])];
	assert.equal(propagate(nodes).statuses.get("R"), "answered", "an explicit answer is never downgraded");
}

// --- it propagates through a whole tree, bottom-up --------------------------------
{
	const nodes = [
		node("R", "open"),
		node("A", "open", ["R"]),
		node("B", "open", ["R"]),
		node("A1", "answered", ["A"]),
		node("A2", "answered", ["A"]),
	];
	const { statuses } = propagate(nodes);
	assert.equal(statuses.get("A"), "answered", "A's children are all answered");
	assert.equal(statuses.get("B"), "open", "B is a leaf and nobody touched it");
	assert.equal(statuses.get("R"), "partial", "R has one answered child (A) and one open one (B)");

	// And only the notes that actually MOVED are written back.
	const changes = statusChanges(nodes, statuses);
	assert.deepEqual(
		changes.map((change) => change.id).sort(),
		["A", "R"],
		"a note whose status already matches is never rewritten"
	);
	assert.deepEqual(changes.find((change) => change.id === "R"), { id: "R", from: "open", to: "partial" });
}

// --- A CYCLE DOES NOT HANG, IS REPORTED, AND IS LEFT ALONE --------------------------
{
	const nodes = [
		node("X", "answered", ["Z"]),
		node("Y", "open", ["X"]),
		node("Z", "open", ["Y"]),
		// A healthy question hanging off the cycle still works.
		node("Leaf", "answered", ["Y"]),
		node("Clean", "open"),
	];

	const started = Date.now();
	const { dag, statuses } = propagate(nodes);
	assert.ok(Date.now() - started < 1000, "propagation over a cycle must terminate, and fast");

	assert.equal(dag.cycles.length, 1, "the loop is reported");
	assert.deepEqual(dag.cycles[0], ["X", "Y", "Z"], "every member of the loop is named");
	assert.deepEqual([...dag.inCycle].sort(), ["X", "Y", "Z"]);

	// Untouched: exactly as the user wrote them.
	assert.equal(statuses.get("X"), "answered");
	assert.equal(statuses.get("Y"), "open", "Y has an answered child but is in a loop — left alone");
	assert.equal(statuses.get("Z"), "open");
	assert.equal(statuses.get("Clean"), "open");

	// And nothing inside the loop is ever written back to disk.
	assert.deepEqual(statusChanges(nodes, statuses), []);
}

// --- a self-loop (`parent::` pointing at the note itself) is a cycle too --------------
{
	const nodes = [node("S", "open", ["S"])];
	const { dag, statuses } = propagate(nodes);
	assert.deepEqual(dag.cycles, [["S"]]);
	assert.equal(statuses.get("S"), "open");
}

// --- a big cycle: proof this is not accidentally quadratic or recursive ---------------
{
	const size = 2000;
	const nodes = [];
	for (let i = 0; i < size; i++) {
		nodes.push(node(`C${i}`, "open", [`C${(i + size - 1) % size}`]));
	}
	const started = Date.now();
	const { dag, statuses } = propagate(nodes);
	assert.ok(Date.now() - started < 2000, "a 2000-node loop must not hang");
	assert.equal(dag.cycles.length, 1);
	assert.equal(dag.cycles[0].length, size);
	assert.equal(statuses.size, size);
}

// --- a 5000-deep chain: iterative, so no stack overflow --------------------------------
{
	const depth = 5000;
	const nodes = [node("D0", "answered")];
	for (let i = 1; i < depth; i++) nodes.push(node(`D${i}`, "answered", [`D${i - 1}`]));
	// D0 is the root; every Di is the child of D(i-1). All answered ⇒ everything is answered.
	const { statuses } = propagate(nodes);
	assert.equal(statuses.get("D0"), "answered");
	assert.equal(statuses.size, depth);
}

// --- a missing parent is IGNORED, not crashed on ----------------------------------------
// `parent:: [[typo]]` is a dangling link, which is an everyday state of an Obsidian vault.
{
	const nodes = [node("A", "open", ["ghost"]), node("B", "answered", ["A"])];
	const { dag, statuses } = propagate(nodes);
	assert.deepEqual(dag.parents.get("A"), [], "the dangling edge is dropped");
	assert.equal(statuses.get("A"), "answered", "A still gets B's answer");
	assert.deepEqual(dag.cycles, []);
}

// --- a duplicate edge is counted once ------------------------------------------------------
{
	const nodes = [node("R", "open"), node("A", "answered", ["R", "R"])];
	const dag = buildDag(nodes);
	assert.deepEqual(dag.children.get("R"), ["A"]);
}

// --- a DAG, not a tree: two parents both see the same child ---------------------------------
{
	const nodes = [
		node("P1", "open"),
		node("P2", "open"),
		node("Shared", "answered", ["P1", "P2"]),
	];
	const { statuses } = propagate(nodes);
	assert.equal(statuses.get("P1"), "answered");
	assert.equal(statuses.get("P2"), "answered");
}

// --- statusFromChildren, directly -------------------------------------------------------------
assert.equal(statusFromChildren([]), null, "no children ⇒ nothing to say");
assert.equal(statusFromChildren(["answered", "answered"]), "answered");
assert.equal(statusFromChildren(["answered", "open"]), "partial");
assert.equal(statusFromChildren(["partial", "open"]), "partial");
assert.equal(statusFromChildren(["open", "open"]), "open");

// --- the board's render order ------------------------------------------------------------------
{
	const nodes = [
		node("R", "open"),
		node("A", "open", ["R"]),
		node("A1", "open", ["A"]),
		node("Orphan", "open"),
	];
	const dag = buildDag(nodes);
	const rows = treeOrder(nodes, dag);
	assert.deepEqual(
		rows.map((row) => [row.node.id, row.depth]),
		[
			["Orphan", 0],
			["R", 0],
			["A", 1],
			["A1", 2],
		],
		"roots sorted, then depth-first through the children"
	);
}

// --- a pure cycle has no root — and must still render ---------------------------------------------
// Otherwise the board silently loses exactly the notes the user most needs to see: the broken ones.
{
	const nodes = [node("X", "open", ["Y"]), node("Y", "open", ["X"])];
	const dag = buildDag(nodes);
	const rows = treeOrder(nodes, dag);
	assert.deepEqual(rows.map((row) => row.node.id).sort(), ["X", "Y"]);
	assert.ok(rows.every((row) => row.inCycle));
}

console.log("ok  question-dag.test.mjs");
