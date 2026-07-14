/**
 * EngineBroker — one engine process, N plugins.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT: five Second Read plugins, all loaded,
 * all spawning their own ~100 MB Python sidecar. Five processes, five ONNX
 * runtimes, five copies of the same index, and five Defender scans. The user
 * would uninstall all five.
 *
 * All Obsidian plugins run in the SAME renderer realm, so a window global is a
 * legitimate singleton registry (Vault Spotlight already publishes
 * `window.vaultSpotlight` and removes it with an identity check on unload). The
 * registry holds ONE EngineHost and a refcount of plugin ids.
 *
 *   acquire() — global present, apiVersion matches, host usable ⇒ add this plugin
 *               to the refcount and hand back THE SAME host. Otherwise construct
 *               one and publish it.
 *   release() — drop the ref. On the LAST ref, kill the child and delete the
 *               global with an identity check.
 *
 * Ownership is not a thing here, and that is deliberate: the host is a plain JS
 * object in a shared realm, so if the plugin that happened to construct it unloads
 * while another still holds a ref, NOTHING HAPPENS — the object and its ChildProcess
 * handle survive, and the surviving plugin will kill it on its own unload. There is
 * no handoff protocol to get wrong.
 *
 * Three independent kill paths mean an orphan is not reachable even so (DESIGN 6.6):
 *   1. last ref released      -> child.kill(), + taskkill /T /F on win32 after a grace
 *   2. stdin EOF              -> the sidecar's read loop ends -> exit(0)   (survives an Obsidian CRASH)
 *   3. --parent-pid watchdog  -> polls every 5 s; parent gone -> exit      (+ --idle-exit 600)
 */
import type { App } from "obsidian";
import { EngineHost, type EngineSettings } from "./EngineHost";

export const ENGINE_API_VERSION = 1;
export const ENGINE_GLOBAL = "__secondReadEngine";

interface EngineRegistry {
	apiVersion: number;
	host: EngineHost;
	refs: Set<string>;
}

type GlobalCarrier = Record<string, unknown>;

function carrier(): GlobalCarrier {
	return globalThis as unknown as GlobalCarrier;
}

function readRegistry(): EngineRegistry | null {
	const value = carrier()[ENGINE_GLOBAL];
	if (!value || typeof value !== "object") return null;
	const reg = value as Partial<EngineRegistry>;
	if (typeof reg.apiVersion !== "number" || !reg.host || !(reg.refs instanceof Set)) return null;
	return reg as EngineRegistry;
}

export class EngineBroker {
	/**
	 * The shared host, refcounted for `pluginId`. Constructing a host does NOT spawn
	 * anything — the child starts lazily on the first request (and `--idle-exit 600`
	 * means it is transparently respawned later), so calling this from onload() is
	 * cheap and starts no process.
	 *
	 * Returns null on mobile / an unsupported platform, and null when an INCOMPATIBLE
	 * client is already in the realm.
	 */
	static acquire(app: App, pluginId: string, settings: EngineSettings): EngineHost | null {
		const existing = readRegistry();

		if (existing && existing.apiVersion !== ENGINE_API_VERSION) {
			// Another Second Read plugin is on a different vendored engine client. Clobbering
			// the global here would strand ITS host (it would never be killed) and hand this
			// plugin an object whose shape we do not know. Refuse instead, and say why.
			// This resolves only when the user updates every Second Read add-on.
			console.warn(
				`[second-read] An add-on with engine client v${existing.apiVersion} is already loaded; ` +
					`this one speaks v${ENGINE_API_VERSION}. Update all Second Read add-ons to the same version. ` +
					"Semantic features are off in this add-on until then."
			);
			return null;
		}

		if (existing) {
			existing.refs.add(pluginId);
			return existing.host;
		}

		const host = new EngineHost(app, settings);
		if (!host.desktop) {
			// Mobile / no window.require. Publish nothing — there is no process to share and
			// no global to clean up. Every caller degrades to the free tier.
			return null;
		}

		const registry: EngineRegistry = {
			apiVersion: ENGINE_API_VERSION,
			host,
			refs: new Set([pluginId]),
		};
		carrier()[ENGINE_GLOBAL] = registry;
		return host;
	}

	/**
	 * Drop this plugin's ref. Kills the child and removes the global only when the last
	 * ref goes — call it unconditionally from onunload(); it is safe when this plugin
	 * never acquired.
	 */
	static release(pluginId: string): void {
		const registry = readRegistry();
		if (!registry) return;
		registry.refs.delete(pluginId);
		if (registry.refs.size > 0) return;

		registry.host.dispose();
		// Identity check: never delete a global some LATER plugin published over ours.
		if (carrier()[ENGINE_GLOBAL] === registry) delete carrier()[ENGINE_GLOBAL];
	}

	/** The running host, without acquiring a ref. For "is the engine already up?" in settings. */
	static peek(): EngineHost | null {
		const registry = readRegistry();
		if (!registry || registry.apiVersion !== ENGINE_API_VERSION) return null;
		return registry.host;
	}

	/** Plugin ids currently holding a ref. Diagnostics only. */
	static refs(): string[] {
		const registry = readRegistry();
		return registry ? [...registry.refs].sort() : [];
	}
}
