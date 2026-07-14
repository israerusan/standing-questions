/** The frontmatter/inline question contract. Pure — see questionParse.mjs. */

export type QuestionStatus = "open" | "partial" | "answered";

export const STATUSES: readonly QuestionStatus[];
export const DEFAULT_STATUS: QuestionStatus;

export interface QuestionKeys {
	typeKey: string;
	questionValue: string;
	statusKey: string;
	parentKey: string;
}

export const DEFAULT_QUESTION_KEYS: Readonly<QuestionKeys>;

export interface ParsedQuestion {
	isQuestion: boolean;
	/** The raw `type` value, for diagnostics. */
	type: string;
	/** Always one of STATUSES — an unrecognised value falls back to "open". */
	status: QuestionStatus;
	/** Parent LINK TEXT, in document order, de-duplicated. Not paths: resolving is Obsidian's job. */
	parents: string[];
}

/** `[[a/b/C.md|alias]]` -> `a/b/C`. A bare string is trimmed and returned. */
export function linkTarget(value: unknown): string;

/** Every `parentKey:: ...` inline field outside a fenced code block. */
export function inlineParents(markdown: string, parentKey?: string): string[];

export function parseQuestion(
	frontmatter: Record<string, unknown> | null | undefined,
	body: string,
	keys?: Partial<QuestionKeys>
): ParsedQuestion;

export function isKnownStatus(status: unknown): boolean;
