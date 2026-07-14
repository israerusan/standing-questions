import type { QuestionStatus } from "./questionParse.d.mts";

/** A question, reduced to what the DAG needs. `id` is the note path; parents are resolved ids. */
export interface QuestionNode {
	id: string;
	title: string;
	status: QuestionStatus;
	/** Resolved parent ids. Ids not present in the node set are dropped by buildDag. */
	parents: string[];
}

export interface QuestionDag {
	/** parent id -> child ids. */
	children: Map<string, string[]>;
	/** child id -> parent ids. */
	parents: Map<string, string[]>;
	/** Every `parent::` loop, each sorted, the list sorted. Empty in a healthy vault. */
	cycles: string[][];
	/** Union of `cycles`. These nodes keep their own status, untouched. */
	inCycle: Set<string>;
}

export const STATUS_RANK: Readonly<Record<QuestionStatus, number>>;

export function buildDag(nodes: QuestionNode[]): QuestionDag;

/** null when there are no children. Otherwise: all answered -> answered; any movement -> partial; else open. */
export function statusFromChildren(childStatuses: QuestionStatus[]): QuestionStatus | null;

export function propagateStatus(
	nodes: QuestionNode[],
	dag: QuestionDag
): Map<string, QuestionStatus>;

export interface StatusChange {
	id: string;
	from: QuestionStatus;
	to: QuestionStatus;
}

/** Only the notes whose propagated status differs from what is written in them. */
export function statusChanges(
	nodes: QuestionNode[],
	statuses: Map<string, QuestionStatus>
): StatusChange[];

export interface TreeRow {
	node: QuestionNode;
	depth: number;
	inCycle: boolean;
}

export function treeOrder(nodes: QuestionNode[], dag: QuestionDag): TreeRow[];
