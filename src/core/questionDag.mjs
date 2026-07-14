/**
 * The question DAG and upward status propagation (DESIGN 8.2). Pure: no `obsidian`, no I/O,
 * no recursion.
 *
 * A question declares its PARENT (`parent:: [[Bigger question]]`), so the edges arrive
 * pointing up. buildDag inverts them into parent -> children, which is the direction
 * propagation runs: answering a leaf moves its parent.
 *
 * THE RULE:
 *
 *     no children              -> the note's own status, untouched
 *     every child answered     -> answered
 *     some child answered or partial -> partial
 *     otherwise                -> open
 *
 * and then the result is MAXED with the note's own status on the rank open < partial <
 * answered, so propagation only ever moves a question FORWARD. A human who wrote
 * `status: answered` on a parent meant it; a sub-question they never got round to closing
 * must not silently reopen their answer.
 *
 * CYCLES. `parent::` is user-authored text, so `A -> B -> A` is one typo away, and a naive
 * post-order walk over it does not return. Cycles are found with an ITERATIVE Tarjan (no
 * recursion, so a pathological vault cannot blow the stack either), every node in one is
 * reported, and every node in one KEEPS ITS OWN STATUS — the add-on says so in the UI
 * rather than guessing. Nodes outside the cycle still propagate normally, including from
 * children that are inside one.
 *
 * A parent id that names no known question is dropped, not crashed on: `parent:: [[typo]]`
 * is a dangling link, and a dangling link is an everyday state of an Obsidian vault.
 */

/** open < partial < answered. Propagation never moves a question backwards down this. */
export const STATUS_RANK = Object.freeze({ open: 0, partial: 1, answered: 2 });

const RANK_TO_STATUS = Object.freeze(["open", "partial", "answered"]);

function rank(status) {
	const value = STATUS_RANK[String(status ?? "").trim().toLowerCase()];
	return value === undefined ? 0 : value;
}

/**
 * Invert parent edges into children, and find every cycle.
 *
 * @param {Array<{id: string, parents?: string[]}>} nodes
 * @returns {{ children: Map<string,string[]>, parents: Map<string,string[]>, cycles: string[][], inCycle: Set<string> }}
 */
export function buildDag(nodes) {
	const list = Array.isArray(nodes) ? nodes : [];
	const known = new Set(list.map((node) => node.id));

	const children = new Map();
	const parents = new Map();
	for (const node of list) {
		children.set(node.id, []);
		parents.set(node.id, []);
	}

	for (const node of list) {
		const seen = new Set();
		for (const parent of node.parents ?? []) {
			// A dangling parent, a duplicate edge, and a note that is its own parent are all
			// things a real vault contains. None of them is an error worth surfacing here —
			// but a self-edge IS a cycle, so it is kept and Tarjan reports it below.
			if (!known.has(parent) || seen.has(parent)) continue;
			seen.add(parent);
			children.get(parent).push(node.id);
			parents.get(node.id).push(parent);
		}
	}

	const { cycles, inCycle } = findCycles(list, children);
	return { children, parents, cycles, inCycle };
}

/**
 * Tarjan's strongly-connected components, iteratively. An SCC of size > 1 is a cycle; an SCC
 * of size 1 is a cycle only when the node links to itself.
 */
function findCycles(nodes, children) {
	const index = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const cycles = [];
	const inCycle = new Set();
	let counter = 0;

	for (const root of nodes) {
		if (index.has(root.id)) continue;

		// Each frame is [nodeId, nextChildIndex].
		const work = [[root.id, 0]];
		index.set(root.id, counter);
		low.set(root.id, counter);
		counter++;
		stack.push(root.id);
		onStack.add(root.id);

		while (work.length > 0) {
			const frame = work[work.length - 1];
			const [id] = frame;
			const kids = children.get(id) ?? [];

			if (frame[1] < kids.length) {
				const child = kids[frame[1]++];
				if (!index.has(child)) {
					index.set(child, counter);
					low.set(child, counter);
					counter++;
					stack.push(child);
					onStack.add(child);
					work.push([child, 0]);
				} else if (onStack.has(child)) {
					low.set(id, Math.min(low.get(id), index.get(child)));
				}
				continue;
			}

			work.pop();
			if (work.length > 0) {
				const parentId = work[work.length - 1][0];
				low.set(parentId, Math.min(low.get(parentId), low.get(id)));
			}

			if (low.get(id) === index.get(id)) {
				const component = [];
				let popped;
				do {
					popped = stack.pop();
					onStack.delete(popped);
					component.push(popped);
				} while (popped !== id);

				const selfLoop = component.length === 1 && (children.get(id) ?? []).includes(id);
				if (component.length > 1 || selfLoop) {
					const cycle = component.slice().sort();
					cycles.push(cycle);
					for (const member of cycle) inCycle.add(member);
				}
			}
		}
	}

	cycles.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return { cycles, inCycle };
}

/** The status a parent takes from its children alone, before it is maxed with its own. */
export function statusFromChildren(childStatuses) {
	if (!childStatuses || childStatuses.length === 0) return null;
	let answered = 0;
	let moved = 0;
	for (const status of childStatuses) {
		const r = rank(status);
		if (r === 2) answered++;
		if (r >= 1) moved++;
	}
	if (answered === childStatuses.length) return "answered";
	if (moved > 0) return "partial";
	return "open";
}

/**
 * The propagated status of every node.
 *
 * Iterative post-order over the children graph, memoized, so a chain 10 000 deep costs no
 * stack. Nodes inside a cycle short-circuit to their own status, which is also what makes
 * the walk terminate on a `parent::` loop.
 *
 * @param {Array<{id: string, status?: string}>} nodes
 * @param {ReturnType<typeof buildDag>} dag
 * @returns {Map<string, "open"|"partial"|"answered">}
 */
export function propagateStatus(nodes, dag) {
	const list = Array.isArray(nodes) ? nodes : [];
	const own = new Map(list.map((node) => [node.id, RANK_TO_STATUS[rank(node.status)]]));
	const resolved = new Map();

	for (const node of list) {
		if (resolved.has(node.id)) continue;

		const work = [[node.id, 0]];
		while (work.length > 0) {
			const frame = work[work.length - 1];
			const id = frame[0];

			if (resolved.has(id)) {
				work.pop();
				continue;
			}

			// A cycle member is left exactly as the user wrote it. This is also the guard that
			// stops the walk from re-entering the loop for ever.
			if (dag.inCycle.has(id)) {
				resolved.set(id, own.get(id) ?? "open");
				work.pop();
				continue;
			}

			const kids = dag.children.get(id) ?? [];
			let waiting = false;
			for (; frame[1] < kids.length; frame[1]++) {
				const child = kids[frame[1]];
				if (!resolved.has(child)) {
					work.push([child, 0]);
					waiting = true;
					break;
				}
			}
			if (waiting) continue;

			const childStatuses = kids.map((child) => resolved.get(child) ?? "open");
			const fromChildren = statusFromChildren(childStatuses);
			const mine = own.get(id) ?? "open";
			resolved.set(
				id,
				fromChildren === null ? mine : RANK_TO_STATUS[Math.max(rank(mine), rank(fromChildren))]
			);
			work.pop();
		}
	}

	return resolved;
}

/**
 * Only the nodes whose propagated status DIFFERS from what is written in the note. This is
 * what the writer iterates: `processFrontMatter` is a vault write, and writing a value that
 * is already there would churn every question note's mtime on every metadata pass — which
 * would, among other things, make Note Decay think the whole vault was just edited.
 */
export function statusChanges(nodes, statuses) {
	const out = [];
	for (const node of Array.isArray(nodes) ? nodes : []) {
		const next = statuses.get(node.id);
		if (next && next !== node.status) out.push({ id: node.id, from: node.status, to: next });
	}
	return out;
}

/** Roots first, then depth-first through children — the order the board renders in. */
export function treeOrder(nodes, dag) {
	const list = Array.isArray(nodes) ? nodes : [];
	const byId = new Map(list.map((node) => [node.id, node]));
	const roots = list
		.filter((node) => (dag.parents.get(node.id) ?? []).length === 0)
		.map((node) => node.id)
		.sort();

	// Every node in a cycle has a parent, so a pure cycle has NO root and would otherwise
	// never render. Seed the walk with the cycle members too, or the board would silently
	// lose them — the exact notes the user most needs to see, because they are broken.
	const seeds = [...roots];
	for (const id of [...dag.inCycle].sort()) {
		if ((dag.parents.get(id) ?? []).every((parent) => dag.inCycle.has(parent))) seeds.push(id);
	}

	const out = [];
	const seen = new Set();
	const stack = seeds.reverse().map((id) => ({ id, depth: 0 }));
	while (stack.length > 0) {
		const { id, depth } = stack.pop();
		if (seen.has(id)) continue;
		seen.add(id);
		const node = byId.get(id);
		if (node) out.push({ node, depth, inCycle: dag.inCycle.has(id) });
		const kids = [...(dag.children.get(id) ?? [])].sort().reverse();
		for (const child of kids) {
			if (!seen.has(child)) stack.push({ id: child, depth: depth + 1 });
		}
	}

	// Anything the walk could not reach (a node whose every parent is unknown to us) still
	// belongs on the board.
	for (const node of list) {
		if (!seen.has(node.id)) out.push({ node, depth: 0, inCycle: dag.inCycle.has(node.id) });
	}
	return out;
}
