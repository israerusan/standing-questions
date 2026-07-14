/** Lead selection (the threshold gate) and the `## Leads` writer. Pure — see leads.mjs. */

export const LEADS_HEADING_TEXT: string;
export const LEADS_HEADING: string;
export const PREVIEW_MAX_CHARS: number;

/** The shipped thresholds. DEFAULT_SETTINGS is seeded from these — the numbers exist once. */
export const DEFAULT_LEAD_OPTIONS: Readonly<{
	leadMinScore: number;
	leadAutoAppend: boolean;
	leadAutoAppendScore: number;
	maxLeads: number;
}>;

export interface Lead {
	/** The question note this lead belongs to (a vault path). */
	question: string;
	/** Wikilink text for the SOURCE note — the possible answer. */
	link: string;
	/** Cosine similarity, 0..1. Absent on a free keyword lead. */
	score?: number;
	/** The matching passage, for the notice and the appended line. */
	preview?: string;
	/** Why a keyword lead matched, e.g. "shares crdt, merge". */
	reason?: string;
	/** The question's title, for the notice copy. */
	questionTitle?: string;
}

export interface SelectLeadsOptions {
	/** Cosine below this is never surfaced. Default 0.75 — conservative on purpose. */
	leadMinScore?: number;
	/** Opt-in. Default false: notify-only, never auto-link. */
	leadAutoAppend?: boolean;
	/** Only meaningful when leadAutoAppend is true. Default 0.85. */
	leadAutoAppendScore?: number;
	/** Most leads surfaced for one note. Default 3. */
	maxLeads?: number;
	/** Questions to skip (e.g. one that already links this note). */
	excludeQuestions?: Iterable<string>;
}

export interface SelectedLeads {
	notify: Lead[];
	autoAppend: Lead[];
}

export function selectLeads(hits: Lead[], options?: SelectLeadsOptions): SelectedLeads;

export function formatLead(lead: Lead): string;

/** True when the note's `## Leads` section already links `link`. */
export function hasLead(markdown: string, link: string): boolean;

/** Idempotent. Creates `## Leads` when absent; preserves everything after it. */
export function appendLead(markdown: string, lead: Lead): string;
