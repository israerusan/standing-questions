/** The free (no-engine, mobile-safe) lead matcher. Pure — see keywordLeads.mjs. */

export const STOPWORDS: ReadonlySet<string>;
export const MIN_TOKEN_CHARS: number;

export function stem(word: string): string;
export function significantTokens(text: string): string[];
export function basename(path: string): string;

export interface KeywordNote {
	path: string;
	title?: string;
	headings?: string[];
	/** Resolved outgoing link paths. */
	links?: string[];
}

export interface KeywordQuestion {
	path: string;
	title?: string;
	status?: string;
	/** The question's body, when cheaply available. */
	text?: string;
	links?: string[];
}

export interface KeywordLead {
	question: string;
	questionTitle: string;
	/** Wikilink text for the source note. */
	link: string;
	reason: string;
	shared: string[];
	sharedLinks: string[];
}

export interface KeywordLeadOptions {
	/** Default 2. One shared word is a coincidence. */
	minSharedTokens?: number;
	maxLeads?: number;
}

export function keywordLeads(
	note: KeywordNote,
	questions: KeywordQuestion[],
	options?: KeywordLeadOptions
): KeywordLead[];
