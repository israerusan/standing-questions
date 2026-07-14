/** Newline-delimited JSON-RPC framing, routing and deadlines. Pure — no I/O, no timers. */

export type EngineErrorCode =
	| "BAD_REQUEST"
	| "NOT_OPEN"
	| "MODEL_ERROR"
	| "IO_ERROR"
	| "CANCELLED"
	| "UNSUPPORTED";

export const ERROR_CODES: Readonly<Record<EngineErrorCode, EngineErrorCode>>;
export const TIMEOUT_ERROR_CODE: EngineErrorCode;
export const TRANSPORT_ERROR_CODE: EngineErrorCode;
export const METHOD_TIMEOUT_MS: Readonly<Record<string, number>>;
export const DEFAULT_TIMEOUT_MS: number;
export const MAX_FRAME_BYTES: number;

export interface EngineWireError {
	code: EngineErrorCode | string;
	message: string;
}

export interface EngineRequest {
	id: number;
	method: string;
	params?: unknown;
}

export interface EngineResponse {
	id: number;
	result?: unknown;
	error?: EngineWireError;
}

export interface EngineNotification {
	method: string;
	params?: unknown;
}

export type EngineMessage = EngineRequest | EngineResponse | EngineNotification;

/** The deadline for `method`, in ms. */
export function timeoutFor(method: string): number;

export class EngineRpcError extends Error {
	constructor(code: EngineErrorCode | string, message?: string, data?: unknown);
	readonly code: EngineErrorCode | string;
	readonly data?: unknown;
}

export class ProtocolError extends Error {
	constructor(message: string);
}

export function rpcError(code: EngineErrorCode | string, message?: string): EngineWireError;

/** Compact JSON + `\n`. Throws ProtocolError on a non-object. */
export function encodeFrame(message: Record<string, unknown>): string;
export function encodeRequest(id: number, method: string, params?: unknown): string;

export function classify(message: unknown): "response" | "notification" | "request" | "invalid";

export interface DecodeResult {
	/** Frames completed by this chunk, in stream order. */
	messages: EngineMessage[];
	/** Raw text of any line that would not parse, or parsed to a shape that is not a frame. */
	malformed: string[];
}

export class FrameDecoder {
	constructor(options?: { maxFrameBytes?: number });
	/** Bytes held back waiting for a `\n`. */
	readonly pending: number;
	push(text: string): DecodeResult;
	reset(): void;
}

export interface PendingEntry<M = unknown> {
	id: number;
	method: string;
	startedAt: number;
	/** `Infinity` when the request was registered with `timeoutMs <= 0`. */
	deadline: number;
	timeoutMs: number;
	/** Opaque caller payload — EngineHost stores the promise settlers and the progress callback here. */
	meta: M;
}

export type RouteResult<M = unknown> =
	| { kind: "result"; id: number; entry: PendingEntry<M>; result: unknown }
	| { kind: "error"; id: number; entry: PendingEntry<M>; error: EngineWireError }
	| { kind: "progress"; for: unknown; entry: PendingEntry<M> | undefined; params: Record<string, unknown> }
	| { kind: "notification"; method: string; params: unknown }
	| { kind: "unmatched"; id: number; message: EngineMessage }
	| { kind: "invalid"; message: unknown };

export class PendingRequests<M = unknown> {
	constructor(options?: { startId?: number });
	readonly size: number;
	nextId(): number;
	add(id: number, entry: { method: string; now: number; timeoutMs?: number; meta?: M }): void;
	has(id: number): boolean;
	get(id: number): PendingEntry<M> | undefined;
	drop(id: number): PendingEntry<M> | undefined;
	route(message: EngineMessage): RouteResult<M>;
	/** Removes and returns every entry whose deadline has passed. */
	expired(now: number): PendingEntry<M>[];
	timeoutError(entry: PendingEntry<M>): EngineWireError;
	/** Removes and returns everything in flight (the child died). */
	drain(): PendingEntry<M>[];
}
