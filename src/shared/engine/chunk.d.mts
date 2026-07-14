/** The canonical markdown chunker. Pure and deterministic — see chunk.mjs. */

export interface Chunk {
	/** FNV-1a-64 of the normalized text, 16 lowercase hex chars. The index's identity for this passage. */
	key: string;
	/** 0-based position within the note, over the chunks that survived the minChars filter. */
	ord: number;
	text: string;
	/** `>`-joined H1..H6 breadcrumb, or "" for text above the first heading. */
	heading: string;
}

export interface ChunkOptions {
	/** Greedy pack target. Default 900. */
	targetChars?: number;
	/** Hard cap; no emitted chunk exceeds it. Default 1400. */
	maxChars?: number;
	/** Chunks shorter than this are dropped unless the note has only one. Default 120. */
	minChars?: number;
	/** Context carried from the previous chunk of the same section. Default 150. */
	overlapChars?: number;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions>;
export const CODE_INLINE_MAX_CHARS: number;
export const CHUNK_NS: Readonly<{ NOTES: "notes"; QUESTIONS: "questions" }>;
export type ChunkNamespace = "notes" | "questions";

/** Lowercase, strip punctuation runs, collapse whitespace. The text a key is computed over. */
export function normalizeChunkText(text: string): string;

/** `fnv1a64(normalizeChunkText(text))`. */
export function chunkKey(text: string): string;

export function chunkNote(markdown: string, options?: ChunkOptions): Chunk[];
