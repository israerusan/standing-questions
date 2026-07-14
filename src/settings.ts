import { DEFAULT_QUESTION_KEYS } from "./core/questionParse.mjs";
import { DEFAULT_LEAD_OPTIONS } from "./core/leads.mjs";

/**
 * The settings SHAPE and its defaults. Rendering lives in ui/SettingsTab.ts — importing "the
 * settings type" must not drag the whole settings tab, and every `obsidian` symbol it
 * touches, into the pure code that only wants to read a threshold.
 */
export interface StandingQuestionsSettings {
	licenseKey: string;
	/** Cached entitlement. Derived from licenseKey, persisted so startup is instant. */
	isPro: boolean;
	licenseEmail: string;
	/** "free" | "valid-pro" | "invalid" — what the License section renders. */
	licenseStatus: string;

	// --- what makes a note a question ---
	typeKey: string;
	questionValue: string;
	statusKey: string;
	parentKey: string;

	// --- the DAG ---
	/** Write a propagated status back into the note. Off ⇒ the board shows it, nothing is written. */
	autoPropagate: boolean;

	// --- leads ---
	/** The free matcher: title/heading token overlap and shared links. Works on mobile. */
	keywordLeadsEnabled: boolean;
	/** Pro + engine. The debounced modify -> chunk -> embed -> cosine pipeline. */
	semanticLeadsEnabled: boolean;
	/**
	 * Cosine below this is never surfaced. DESIGN 6.5 tabulates 0.60; this ships at 0.75.
	 *
	 * The difference is deliberate and it is the whole product. At 0.60 an "unrelated" pair of
	 * English notes already sits at 0.05–0.25 and a merely "related" pair at 0.40–0.60 — so
	 * 0.60 is the very bottom of "related", and a vault with 40 open questions would interrupt
	 * the user several times a day about notes that merely share a subject area. The first
	 * false positive is charming; the fifth gets the add-on disabled. 0.75 is the bottom of the
	 * near-duplicate band: when it fires, the note really is about that question.
	 *
	 * It is a slider, and a user who wants the firehose can have it.
	 */
	leadMinScore: number;
	/** Opt-in. Default OFF: notify-only, never auto-link. */
	leadAutoAppend: boolean;
	/** Only consulted when leadAutoAppend is on. */
	leadAutoAppendScore: number;
	/** Notes shorter than this are not worth embedding — a stub answers nothing. */
	minLeadChars: number;
	/** Most leads surfaced for one edited note, per pass. */
	maxLeads: number;
	/** Folders whose notes are never scanned for leads, and never indexed as questions. */
	excludeFolders: string[];

	// --- engine ---
	/** Pro + engine. A BYO path to an engine binary the user already has (DESIGN 7.2). */
	enginePath: string;

	schemaVersion: number;
}

export const DEFAULT_SETTINGS: StandingQuestionsSettings = {
	licenseKey: "",
	isPro: false,
	licenseEmail: "",
	licenseStatus: "free",

	typeKey: DEFAULT_QUESTION_KEYS.typeKey,
	questionValue: DEFAULT_QUESTION_KEYS.questionValue,
	statusKey: DEFAULT_QUESTION_KEYS.statusKey,
	parentKey: DEFAULT_QUESTION_KEYS.parentKey,

	autoPropagate: true,

	keywordLeadsEnabled: true,
	semanticLeadsEnabled: true,
	// The thresholds live in core/leads.mjs, so the numbers exist exactly once and are testable
	// without importing TypeScript. See the comment on DEFAULT_LEAD_OPTIONS for why 0.75.
	leadMinScore: DEFAULT_LEAD_OPTIONS.leadMinScore,
	leadAutoAppend: DEFAULT_LEAD_OPTIONS.leadAutoAppend,
	leadAutoAppendScore: DEFAULT_LEAD_OPTIONS.leadAutoAppendScore,
	minLeadChars: 600,
	maxLeads: DEFAULT_LEAD_OPTIONS.maxLeads,
	excludeFolders: [],

	enginePath: "",

	schemaVersion: 1,
};

/** Debounce on `vault.on("modify")` before a note is considered for leads (DESIGN 8.2). */
export const LEAD_DEBOUNCE_MS = 2500;

/** Rebuild the question index after the metadata cache settles. */
export const INDEX_DEBOUNCE_MS = 800;

/** Propagate statuses back into notes on this cadence, at most. A vault write is not free. */
export const PROPAGATE_DEBOUNCE_MS = 4000;

/** Coalesce a burst of settings changes (a slider drag) into one write. */
export const SAVE_DEBOUNCE_MS = 400;
