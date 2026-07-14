/**
 * The Second Read engine wire protocol: newline-delimited JSON-RPC over the
 * sidecar's stdin/stdout. NOT HTTP — a loopback listener is authenticated by
 * nothing, trips third-party firewall/EDR prompts on any listen(), and needs
 * ~40 lines of token/Origin/Host checks that stdio makes structurally
 * impossible to get wrong (DESIGN 6.1).
 *
 * This module is PURE: no I/O, no timers, no `obsidian`, no Node. It owns
 *   - framing        (encode / decode, including split and partial frames)
 *   - routing        (which response belongs to which in-flight request)
 *   - timeout policy (deadline bookkeeping; the CALLER supplies `now`)
 * so that all three are testable without spawning anything. EngineHost.ts is
 * the thin, untestable shell that pushes bytes through it.
 *
 * Frames (DESIGN 6.1):
 *   request       {"id":<int>,"method":<string>,"params":{...}}
 *   response      {"id":<int>,"result":{...}}  |  {"id":<int>,"error":{"code":"...","message":"..."}}
 *   notification  {"method":"progress","params":{"for":7,"done":120,"total":900}}   // NO `id` key
 */

/** Every error code the sidecar may return. DESIGN 6.1. */
export const ERROR_CODES = Object.freeze({
	BAD_REQUEST: "BAD_REQUEST",
	NOT_OPEN: "NOT_OPEN",
	MODEL_ERROR: "MODEL_ERROR",
	IO_ERROR: "IO_ERROR",
	CANCELLED: "CANCELLED",
	UNSUPPORTED: "UNSUPPORTED",
});

/**
 * Client-synthesized failures reuse the sidecar's own codes rather than
 * inventing new ones, so every consumer has exactly one code vocabulary to
 * switch on. A timeout and a dead pipe are both IO_ERROR; a superseded request
 * is CANCELLED, identically to the sidecar's own cancel path.
 */
export const TIMEOUT_ERROR_CODE = ERROR_CODES.IO_ERROR;
export const TRANSPORT_ERROR_CODE = ERROR_CODES.IO_ERROR;

/** Per-method deadlines, in ms. `health` is the spawn handshake and is capped at 15 s (DESIGN 7.3 step 8). */
export const METHOD_TIMEOUT_MS = Object.freeze({
	health: 15000,
	open: 60000,
	upsert: 300000,
	delete: 60000,
	rename: 30000,
	query: 30000,
	stats: 15000,
	cancel: 15000,
	embed: 60000,
	shutdown: 5000,
});

/** Fallback deadline for a method not named above. */
export const DEFAULT_TIMEOUT_MS = 30000;

/** A single un-framed line longer than this means the child is not speaking NDJSON at all. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** The deadline for `method`, in ms. */
export function timeoutFor(method) {
	const ms = METHOD_TIMEOUT_MS[method];
	return typeof ms === "number" ? ms : DEFAULT_TIMEOUT_MS;
}

/** An RPC failure carrying one of ERROR_CODES. Thrown by EngineHost; constructed here. */
export class EngineRpcError extends Error {
	constructor(code, message, data) {
		super(String(message ?? code));
		this.name = "EngineRpcError";
		this.code = code;
		this.data = data;
	}
}

/** A protocol-level failure: the child emitted something that is not NDJSON. */
export class ProtocolError extends Error {
	constructor(message) {
		super(message);
		this.name = "ProtocolError";
	}
}

/** `{code, message}` — the shape the sidecar puts in `error`. */
export function rpcError(code, message) {
	return { code, message: String(message ?? code) };
}

/**
 * One frame: compact JSON, `\n`-terminated. JSON.stringify escapes every literal
 * newline inside strings, so a frame can never contain an interior `\n` and the
 * decoder's line split is total.
 */
export function encodeFrame(message) {
	if (message === null || typeof message !== "object") {
		throw new ProtocolError("A frame must be a JSON object.");
	}
	return JSON.stringify(message) + "\n";
}

/** The wire bytes for a request. */
export function encodeRequest(id, method, params) {
	if (!Number.isInteger(id) || id < 1) throw new ProtocolError(`Bad request id: ${String(id)}`);
	if (typeof method !== "string" || method.length === 0) {
		throw new ProtocolError("A request needs a method name.");
	}
	return encodeFrame(params === undefined ? { id, method } : { id, method, params });
}

/** "response" | "notification" | "request" | "invalid" — what the child just said. */
export function classify(message) {
	if (message === null || typeof message !== "object" || Array.isArray(message)) return "invalid";
	const hasId = Object.prototype.hasOwnProperty.call(message, "id");
	if (hasId) {
		if (!Number.isInteger(message.id)) return "invalid";
		const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
		const hasError = Object.prototype.hasOwnProperty.call(message, "error");
		if (hasResult || hasError) return "response";
		if (typeof message.method === "string") return "request";
		return "invalid";
	}
	if (typeof message.method === "string") return "notification";
	return "invalid";
}

/**
 * Reassembles frames from an arbitrarily chopped stdout stream. A read may hand
 * us half a frame, three frames, or three-and-a-half; only the trailing partial
 * line is retained.
 *
 * A malformed line is REPORTED AND SKIPPED, never thrown: one stray `print()` in
 * the sidecar must cost one frame, not the whole session. (The sidecar's own rule
 * is that all logging goes to stderr — DESIGN 6.1 — so a malformed line is a bug
 * worth surfacing, which is what `malformed` is for.)
 */
export class FrameDecoder {
	constructor(options) {
		const opts = options ?? {};
		this._buffer = "";
		this._maxBytes = typeof opts.maxFrameBytes === "number" ? opts.maxFrameBytes : MAX_FRAME_BYTES;
	}

	/** Bytes held back waiting for a `\n`. */
	get pending() {
		return this._buffer.length;
	}

	reset() {
		this._buffer = "";
	}

	/**
	 * Feed a stdout chunk. Returns every complete frame it completed, plus the raw
	 * text of any line that would not parse.
	 */
	push(text) {
		this._buffer += String(text ?? "");
		const messages = [];
		const malformed = [];

		let cut = this._buffer.indexOf("\n");
		while (cut !== -1) {
			const line = this._buffer.slice(0, cut).replace(/\r$/, "");
			this._buffer = this._buffer.slice(cut + 1);
			if (line.trim().length > 0) {
				let parsed;
				try {
					parsed = JSON.parse(line);
				} catch {
					malformed.push(line);
					cut = this._buffer.indexOf("\n");
					continue;
				}
				if (classify(parsed) === "invalid") malformed.push(line);
				else messages.push(parsed);
			}
			cut = this._buffer.indexOf("\n");
		}

		if (this._buffer.length > this._maxBytes) {
			const held = this._buffer.length;
			this._buffer = "";
			throw new ProtocolError(
				`The engine emitted ${held} bytes with no frame terminator — it is not speaking newline-delimited JSON.`
			);
		}

		return { messages, malformed };
	}
}

/**
 * Request-id allocation, response routing, and deadlines.
 *
 * Responses arrive out of order by design (a slow `upsert` and a fast `query` are
 * in flight together, and `cancel` deliberately makes an earlier id settle LAST),
 * so a queue would be wrong: this is a Map keyed by id.
 *
 * There are no timers here. `expired(now)` is polled by the host's single interval,
 * which keeps the whole policy pure and lets a test drive the clock.
 */
export class PendingRequests {
	constructor(options) {
		const opts = options ?? {};
		this._next = typeof opts.startId === "number" ? opts.startId : 1;
		this._map = new Map();
	}

	/** In-flight count. */
	get size() {
		return this._map.size;
	}

	/** A fresh, monotonically increasing request id. Ids are never reused within a process. */
	nextId() {
		return this._next++;
	}

	/**
	 * Track an in-flight request. `meta` is opaque to this module — EngineHost stows
	 * the promise's resolve/reject and any progress callback in it, and this module
	 * hands it back on settle. That is what keeps the routing pure.
	 */
	add(id, entry) {
		const e = entry ?? {};
		const now = typeof e.now === "number" ? e.now : 0;
		const timeoutMs = typeof e.timeoutMs === "number" ? e.timeoutMs : timeoutFor(e.method);
		this._map.set(id, {
			id,
			method: e.method,
			startedAt: now,
			deadline: timeoutMs > 0 ? now + timeoutMs : Number.POSITIVE_INFINITY,
			timeoutMs,
			meta: e.meta,
		});
	}

	has(id) {
		return this._map.has(id);
	}

	get(id) {
		return this._map.get(id);
	}

	/** Forget an id without settling it (the caller settled it itself). */
	drop(id) {
		const entry = this._map.get(id);
		this._map.delete(id);
		return entry;
	}

	/**
	 * Route one decoded frame.
	 *
	 *   { kind: "result",       id, entry, result }
	 *   { kind: "error",        id, entry, error }        // {code, message}
	 *   { kind: "progress",     for, entry, params }      // entry is undefined if the request already settled
	 *   { kind: "notification", method, params }
	 *   { kind: "unmatched",    id, message }             // a response to an id we are not waiting on
	 *   { kind: "invalid",      message }
	 *
	 * "result" and "error" remove the entry. A duplicate or very late response for an
	 * id we already settled therefore lands in "unmatched" and is dropped, instead of
	 * settling a promise twice.
	 */
	route(message) {
		const kind = classify(message);

		if (kind === "notification") {
			if (message.method === "progress") {
				const params = message.params ?? {};
				const target = params.for;
				return {
					kind: "progress",
					for: target,
					entry: Number.isInteger(target) ? this._map.get(target) : undefined,
					params,
				};
			}
			return { kind: "notification", method: message.method, params: message.params ?? {} };
		}

		if (kind !== "response") return { kind: "invalid", message };

		const entry = this._map.get(message.id);
		if (!entry) return { kind: "unmatched", id: message.id, message };
		this._map.delete(message.id);

		if (Object.prototype.hasOwnProperty.call(message, "error")) {
			const raw = message.error ?? {};
			const code = typeof raw.code === "string" ? raw.code : ERROR_CODES.MODEL_ERROR;
			return {
				kind: "error",
				id: message.id,
				entry,
				error: rpcError(code, raw.message ?? code),
			};
		}
		return { kind: "result", id: message.id, entry, result: message.result };
	}

	/** Remove and return every entry whose deadline has passed. The host rejects them. */
	expired(now) {
		const out = [];
		for (const entry of this._map.values()) {
			if (entry.deadline <= now) out.push(entry);
		}
		for (const entry of out) this._map.delete(entry.id);
		return out;
	}

	/** The synthetic error for a request that ran out of clock. */
	timeoutError(entry) {
		return rpcError(
			TIMEOUT_ERROR_CODE,
			`The engine did not answer "${String(entry?.method ?? "?")}" within ${String(entry?.timeoutMs ?? "?")} ms.`
		);
	}

	/** Remove and return everything in flight. Used when the child dies. */
	drain() {
		const out = [...this._map.values()];
		this._map.clear();
		return out;
	}
}
