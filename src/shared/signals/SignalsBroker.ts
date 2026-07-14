import type { App } from "obsidian";
import type { SignalKind } from "./signalsAggregate.mjs";
import type { SignalStore } from "./SignalStore";

/**
 * Single-writer election for the shared Signals log (DESIGN 5.2).
 *
 * THE PROBLEM. Note Decay needs `lastOpen`. Effort Index needs `editMs` and `revisions`.
 * A user can install both. If both attach listeners and both append, the log double-counts
 * AND two writers interleave partial lines into one file. That is corruption, not a
 * rounding error.
 *
 * THE ELECTION IS PER EVENT KIND, NOT PER PLUGIN. This is the whole point, and getting it
 * wrong once already reduced a product to a no-op:
 *
 *   Note Decay emits open / rename / delete, and NEVER edit or dwell.
 *   Effort Index emits edit / dwell, and NEVER open.
 *
 * A per-plugin slot means whoever recorded first won everything, and every event the loser
 * emitted was dropped forever — with both installed, Effort Index recorded ZERO editing
 * milliseconds for every note in the vault, and which plugin lost was listener-registration
 * order: a coin flip per user, re-rolled on every restart. So the registry maps
 * KIND -> owner, and a plugin claims only the kinds it actually emits (lazily, on the first
 * event of that kind).
 *
 * WHY TWO WRITERS ARE SAFE ONCE THE KINDS ARE DISJOINT. Each plugin appends to its OWN
 * shard file (`<writerId>.ndjson`) and `foldSignals` merges every shard in one pass. Two
 * writers never touch one file, and no event is in two shards. What the election still buys
 * — and the ONLY thing it buys — is that an event BOTH plugins observe (`open`, which both
 * listen for) is appended exactly once. Removing the guard would double-count it.
 *
 * Election is LAZY and happens INSIDE `record()`. If a kind's slot is empty, stale, or held
 * by a plugin that has gone away, the caller claims it. There is no custom event, no handoff
 * protocol, no heartbeat, and nothing to leak: an unloading plugin drops every kind it owns,
 * and the next event from any surviving plugin re-elects instantly.
 *
 * The registry is a property on the global object. That is deliberate: separate plugins are
 * separate bundles with separate module registries, so a module-level variable would give
 * each plugin its own private "singleton" and elect nobody.
 */

/**
 * Bumped to 2 when the slot went from one writer to one writer PER KIND. A plugin still
 * vendoring v1 sees a higher version and stays a reader (it defers to the newer build);
 * a v2 plugin treats a v1 registry as stale and takes it over. Mixed installs therefore
 * degrade to exactly the old behaviour rather than corrupting anything, and resolve the
 * moment the user updates every Second Read add-on.
 */
export const SIGNALS_API_VERSION = 2;
export const SIGNALS_GLOBAL = "__secondReadSignals";

export interface SignalsOwner {
	/** The plugin that owns appending this kind. */
	pluginId: string;
	/** That plugin's store. Readers hold their own read-only one. */
	store: SignalStore;
}

export interface SignalsRegistry {
	apiVersion: number;
	/** Event kind -> the plugin that appends it. A kind with no entry is up for election. */
	owners: Record<string, SignalsOwner | undefined>;
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
	if (!candidate.owners || typeof candidate.owners !== "object") return null;
	return candidate as SignalsRegistry;
}

function isValidOwner(owner: SignalsOwner | undefined): owner is SignalsOwner {
	if (!owner || typeof owner !== "object") return false;
	if (typeof owner.pluginId !== "string" || owner.pluginId.length === 0) return false;
	return Boolean(owner.store) && typeof owner.store === "object";
}

/**
 * Is the plugin holding this kind still there?
 *
 * Primary signal: the store's own `disposed` flag, which `SignalStore.dispose()` sets from
 * `onunload()`. This is public API of our own object and works structurally across bundles.
 *
 * Fallback: Obsidian's plugin registry, consulted ONLY when the store does not report a
 * usable flag (an older vendored copy). When neither signal is readable we answer "alive"
 * — refusing to steal a slot we cannot prove is vacant. The cost of a wrong "alive" is
 * that events of that kind stop being logged until the next reload; the cost of a wrong
 * "dead" is two writers on one kind, which double-counts.
 */
function isOwnerAlive(app: App, owner: SignalsOwner): boolean {
	const probe = owner.store as unknown as LivenessProbe;
	if (typeof probe.disposed === "boolean") return !probe.disposed;

	const registered = (app as unknown as PluginRegistryHost).plugins?.plugins;
	if (!registered || typeof registered !== "object") return true;
	return Object.prototype.hasOwnProperty.call(registered, owner.pluginId);
}

function publish(): SignalsRegistry {
	const registry: SignalsRegistry = {
		apiVersion: SIGNALS_API_VERSION,
		owners: Object.create(null) as Record<string, SignalsOwner | undefined>,
	};
	globalHost()[SIGNALS_GLOBAL] = registry;
	return registry;
}

export class SignalsBroker {
	/** The current registry, or null when vacant/unreadable. Exposed for diagnostics and tests. */
	static registry(): SignalsRegistry | null {
		return readRegistry();
	}

	/**
	 * Claim the writer slot FOR ONE EVENT KIND if it is vacant, stale, or ours already.
	 *
	 * @returns true when THIS plugin may append an event of `kind` after the call. False
	 * means another loaded plugin logs that kind and this plugin must stay a reader for it —
	 * `record()` returns immediately on false, which is what keeps each kind single-writer.
	 */
	static claimIfVacant(app: App, pluginId: string, store: SignalStore, kind: SignalKind): boolean {
		if (typeof kind !== "string" || kind.length === 0) return false;

		let current = readRegistry();

		if (current) {
			// A NEWER build of the suite owns the log. It knows about kinds and fields we do
			// not. Defer: it is listening for the same events, so nothing is lost by reading.
			if (current.apiVersion > SIGNALS_API_VERSION) return false;

			// An OLDER build's registry has the wrong SHAPE (one writer for everything). Its
			// owner will stop appending as soon as it sees our higher apiVersion, so replacing
			// the registry wholesale is safe — and leaving it in place is not: it is the bug.
			if (current.apiVersion < SIGNALS_API_VERSION) current = publish();
		} else {
			current = publish();
		}

		const owner = current.owners[kind];
		if (isValidOwner(owner)) {
			// Already ours. Idempotent — re-claiming must not swap the registered store out
			// from under a flush that is mid-flight.
			if (owner.pluginId === pluginId) return true;
			if (isOwnerAlive(app, owner)) return false;
			// Otherwise the owner is gone. Fall through and take the kind.
		}

		current.owners[kind] = { pluginId, store };
		return true;
	}

	/** True when `pluginId` appends `kind`. A pure read — never elects. */
	static isWriterFor(pluginId: string, kind: SignalKind): boolean {
		const current = readRegistry();
		if (!current || current.apiVersion !== SIGNALS_API_VERSION) return false;
		const owner = current.owners[kind];
		return isValidOwner(owner) && owner.pluginId === pluginId;
	}

	/** True when `pluginId` appends AT LEAST ONE kind. The "am I a writer at all?" question
	 *  the settings tabs ask. A pure read — never elects. */
	static isWriter(pluginId: string): boolean {
		return SignalsBroker.kindsOwnedBy(pluginId).length > 0;
	}

	/** The kinds `pluginId` currently appends, sorted. Diagnostics and tests. */
	static kindsOwnedBy(pluginId: string): string[] {
		const current = readRegistry();
		if (!current || current.apiVersion !== SIGNALS_API_VERSION) return [];
		const kinds: string[] = [];
		for (const [kind, owner] of Object.entries(current.owners)) {
			if (isValidOwner(owner) && owner.pluginId === pluginId) kinds.push(kind);
		}
		return kinds.sort();
	}

	/**
	 * Called from `onunload()`. Drops every kind this plugin owns, so the next event of that
	 * kind from any surviving Second Read plugin re-elects a writer for it. Never touches a
	 * kind somebody else owns — an unloading reader must not evict a live writer. The global
	 * itself is deleted once no kind has an owner.
	 */
	static releaseIfOwner(pluginId: string): void {
		const current = readRegistry();
		if (!current) return;
		let remaining = 0;
		for (const [kind, owner] of Object.entries(current.owners)) {
			if (isValidOwner(owner) && owner.pluginId === pluginId) delete current.owners[kind];
			else if (isValidOwner(owner)) remaining += 1;
		}
		if (remaining === 0 && globalHost()[SIGNALS_GLOBAL] === current) {
			delete globalHost()[SIGNALS_GLOBAL];
		}
	}
}
