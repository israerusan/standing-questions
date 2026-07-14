import type { App } from "obsidian";
import type { SignalStore } from "./SignalStore";

/**
 * Single-writer election for the shared Signals log (DESIGN 5.2).
 *
 * THE PROBLEM. Note Decay needs `lastOpen`. Effort Index needs `editMs` and `revisions`.
 * Both derive from the same three events, both must work standalone, and neither may
 * depend on the other. If both are installed and both attach listeners, both would append
 * every event: the log double-counts, and two processes appending to one file interleave
 * partial writes. That is corruption, not a rounding error.
 *
 * THE SOLUTION. Every plugin attaches its OWN listeners (via `registerEvent`, so cleanup
 * is automatic and nothing leaks) and calls `store.record()` for every event. `record()`
 * is a NO-OP unless this plugin currently holds the writer slot — so exactly one copy of
 * each event is ever appended, no matter how many Second Read plugins are loaded. Readers
 * hold their own read-only store and merge every shard they find.
 *
 * Election is LAZY and happens INSIDE `record()`. If the slot is empty, stale, or held by
 * a plugin that has gone away, the caller claims it. There is no custom event, no handoff
 * protocol, no heartbeat, and nothing to leak: an unloading plugin clears the slot if it
 * owns it, and the next event from any surviving plugin re-elects instantly.
 *
 * The slot is a property on the global object. That is deliberate: separate plugins are
 * separate bundles with separate module registries, so a module-level variable would give
 * each plugin its own private "singleton" and elect nobody.
 */

export const SIGNALS_API_VERSION = 1;
export const SIGNALS_GLOBAL = "__secondReadSignals";

export interface SignalsRegistry {
	apiVersion: number;
	/** Whoever currently owns the append. */
	writerPluginId: string;
	/** The writer's store. Readers hold their own read-only one. */
	store: SignalStore;
}

/** The shape the broker actually needs from the registered store. Structural on purpose:
 *  the object in the slot came out of ANOTHER plugin's bundle, so it is never an
 *  `instanceof` our `SignalStore` — only its shape can be trusted. */
interface LivenessProbe {
	disposed?: boolean;
}

/** `app.plugins` is not in the public typings. It is read defensively and only as a
 *  fallback (see `isOwnerAlive`), never as the primary liveness signal. */
interface PluginRegistryHost {
	plugins?: {
		plugins?: Record<string, unknown>;
	};
}

function globalHost(): Record<string, unknown> {
	return globalThis as unknown as Record<string, unknown>;
}

function readRegistry(): SignalsRegistry | null {
	const value = globalHost()[SIGNALS_GLOBAL];
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<SignalsRegistry>;
	if (typeof candidate.apiVersion !== "number") return null;
	if (typeof candidate.writerPluginId !== "string" || candidate.writerPluginId.length === 0) return null;
	if (!candidate.store || typeof candidate.store !== "object") return null;
	return candidate as SignalsRegistry;
}

/**
 * Is the plugin holding the slot still there?
 *
 * Primary signal: the store's own `disposed` flag, which `SignalStore.dispose()` sets from
 * `onunload()`. This is public API of our own object and works structurally across bundles.
 *
 * Fallback: Obsidian's plugin registry, consulted ONLY when the store does not report a
 * usable flag (an older vendored copy). When neither signal is readable we answer "alive"
 * — refusing to steal a slot we cannot prove is vacant. The cost of a wrong "alive" is
 * that events stop being logged until the next reload; the cost of a wrong "dead" is two
 * writers on one file, which is the exact corruption this class exists to prevent.
 */
function isOwnerAlive(app: App, registry: SignalsRegistry): boolean {
	const probe = registry.store as unknown as LivenessProbe;
	if (typeof probe.disposed === "boolean") return !probe.disposed;

	const registered = (app as unknown as PluginRegistryHost).plugins?.plugins;
	if (!registered || typeof registered !== "object") return true;
	return Object.prototype.hasOwnProperty.call(registered, registry.writerPluginId);
}

export class SignalsBroker {
	/** The current slot, or null when vacant/unreadable. Exposed for diagnostics and tests. */
	static registry(): SignalsRegistry | null {
		return readRegistry();
	}

	/**
	 * Claim the writer slot if it is vacant, stale, or ours already.
	 *
	 * @returns true when THIS plugin may append after the call. False means another loaded
	 * plugin owns the log and this plugin must stay a reader — `record()` returns
	 * immediately on false, which is what keeps the log single-writer.
	 */
	static claimIfVacant(app: App, pluginId: string, store: SignalStore): boolean {
		const current = readRegistry();
		if (current) {
			// Already ours. Idempotent — re-claiming must not swap the registered store out
			// from under a flush that is mid-flight.
			if (current.writerPluginId === pluginId) return true;

			// A NEWER build of the suite owns the log. It knows about fields we do not.
			// Defer: it is appending the same events, so nothing is lost by staying a reader.
			if (current.apiVersion > SIGNALS_API_VERSION) return false;

			// A live owner on our own API version keeps the slot.
			if (current.apiVersion === SIGNALS_API_VERSION && isOwnerAlive(app, current)) return false;

			// Otherwise the slot is stale: an older API version, or an owner that is gone.
			// Fall through and take it.
		}

		const claimed: SignalsRegistry = {
			apiVersion: SIGNALS_API_VERSION,
			writerPluginId: pluginId,
			store,
		};
		globalHost()[SIGNALS_GLOBAL] = claimed;
		return true;
	}

	/** True when `pluginId` holds the slot on our API version. A pure read — never elects. */
	static isWriter(pluginId: string): boolean {
		const current = readRegistry();
		if (!current) return false;
		return current.apiVersion === SIGNALS_API_VERSION && current.writerPluginId === pluginId;
	}

	/**
	 * Called from `onunload()`. Clears the slot iff this plugin owns it, so the next event
	 * from any surviving Second Read plugin re-elects a writer. Never clears somebody
	 * else's slot — an unloading reader must not evict the live writer.
	 */
	static releaseIfOwner(pluginId: string): void {
		const current = readRegistry();
		if (!current || current.writerPluginId !== pluginId) return;
		delete globalHost()[SIGNALS_GLOBAL];
	}
}
