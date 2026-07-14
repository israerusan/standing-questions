/** Hand-written types for signalsAggregate.mjs. Drift between the two is caught by
 *  `tsc --noEmit` in obsidian-plugin-core and in every plugin repo that vendors them. */

export const DEFAULT_REVISION_GAP_MS: number;
export const DEFAULT_MIN_SESSION_MS: number;
export const DEFAULT_DWELL_CAP_MS: number;
export const DEFAULT_IDLE_CUTOFF_MS: number;
export const DEFAULT_RETENTION_MS: number;
export const SIGNALS_MAX_LINES: number;
export const EVENT_KINDS: readonly SignalKind[];

export interface OpenEvent {
	t: number;
	k: "open";
	p: string;
}
export interface EditEvent {
	t: number;
	k: "edit";
	p: string;
	/** ACTIVE editing ms: last keystroke − session start. The idle tail is never in here. */
	ms: number;
	keys?: number;
}
export interface DwellEvent {
	t: number;
	k: "dwell";
	p: string;
	ms: number;
}
export interface RenameEvent {
	t: number;
	k: "rename";
	/** The NEW path. */
	p: string;
	/** The OLD path. */
	from: string;
}
export interface DeleteEvent {
	t: number;
	k: "delete";
	p: string;
}

export type SignalEvent = OpenEvent | EditEvent | DwellEvent | RenameEvent | DeleteEvent;

/** The closed set of event kinds. The writer slot is elected PER KIND (see SignalsBroker):
 *  Note Decay emits open/rename/delete, Effort Index emits edit/dwell, and a per-plugin
 *  election would drop one of those sets entirely. */
export type SignalKind = SignalEvent["k"];

export interface NoteSignals {
	/** ms — the first moment this store observed the note at all. */
	firstSeen: number;
	/** ms — 0 when never opened while a Second Read plugin was watching. */
	lastOpen: number;
	opens: number;
	/** Total ACTIVE editing ms. */
	editMs: number;
	/** Contiguous bursts. */
	editSessions: number;
	/** Bursts merged when separated by less than `revisionGapMs`. */
	revisions: number;
	lastEdit: number;
	dwellMs: number;
}

export type SignalsIndex = Record<string, NoteSignals>;

export interface FoldOptions {
	revisionGapMs?: number;
	minSessionMs?: number;
	dwellCapMs?: number;
}

export function emptyNoteSignals(firstSeen?: number): NoteSignals;
export function isSignalEvent(value: unknown): value is SignalEvent;
export function parseSignalLog(text: string | null | undefined): {
	events: SignalEvent[];
	malformed: number;
};
export function serializeEvent(event: SignalEvent): string;
export function foldSignals(
	events: readonly SignalEvent[],
	prior?: SignalsIndex | null,
	opts?: FoldOptions
): SignalsIndex;
export function mergeSignals(indexes: readonly (SignalsIndex | null | undefined)[]): SignalsIndex;
export function lastActivity(signals: NoteSignals | null | undefined): number;
export function pruneSignals(
	index: SignalsIndex,
	livePaths: Set<string> | null | undefined,
	now: number,
	retentionMs?: number
): SignalsIndex;
