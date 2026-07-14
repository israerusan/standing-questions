// A STORED PRO KEY THAT NO LONGER VERIFIES MUST DOWNGRADE THE ADD-ON, NOT BRICK IT.
//
// onload() runs `await this.refreshLicense()` near the top. When a persisted `isPro: true`
// entitlement stops verifying — a revoked key (the whole point of the by-value denylist), a
// rotated keypair, or a hand-edited/corrupt data.json — refreshLicense() flips Pro→free and
// PERSISTS, i.e. it calls saveSettings(). saveSettings() touches `this.index`. If the index is
// built AFTER refreshLicense() (or saveSettings dereferences it unguarded), onload() throws
// `Cannot read properties of undefined`, Obsidian shows "Failed to load plugin", and the user
// gets no free tier and no settings tab to paste a replacement key. The revocation mechanism
// would brick the add-on it is meant to gracefully downgrade.
//
// This drives the real sequence onload() runs — loadSettings() then refreshLicense() — over a
// real (overridden) data.json holding exactly that downgrade, and asserts it completes as free.
// It fails against the pre-fix code (unguarded `this.index.updateSettings` on an undefined index).
import assert from "node:assert";
import StandingQuestionsPlugin from "../src/main";

// The plugin's debounced saves use window.setTimeout; there is no window in the test runtime.
const g = globalThis as unknown as { window?: unknown };
g.window = { setTimeout: () => 0, clearTimeout: () => undefined };

async function main(): Promise<void> {
	// Minimal app surface refreshLicense()'s repaint path (renderBoards) actually touches.
	const app = { workspace: { getLeavesOfType: () => [] } };
	const manifest = { id: "standing-questions", version: "1.0.0", dir: "/vault/.obsidian/plugins/standing-questions" };

	// A persisted Pro entitlement whose key does not verify — the exact shape a revoked or
	// keypair-rotated install has on disk after an update.
	const storedData = {
		isPro: true,
		licenseKey: "was-valid-yesterday-now-does-not-verify",
		licenseEmail: "buyer@example.com",
		licenseStatus: "valid-pro",
	};

	const plugin = new StandingQuestionsPlugin(app, manifest) as unknown as {
		loadData(): Promise<unknown>;
		saveData(data: unknown): Promise<void>;
		loadSettings(): Promise<void>;
		refreshLicense(): Promise<boolean>;
		settings: { isPro: boolean; licenseKey: string; licenseStatus: string };
	};

	let saved: unknown = null;
	plugin.loadData = async () => storedData;
	plugin.saveData = async (data: unknown) => {
		saved = data;
	};

	// The first two statements of onload(), in order. Pre-fix, the second one threw here.
	await plugin.loadSettings();
	await assert.doesNotReject(
		() => plugin.refreshLicense(),
		"a stored Pro key that no longer verifies must downgrade the add-on, not brick onload()"
	);

	assert.equal(plugin.settings.isPro, false, "the stale Pro entitlement must be cleared to free");
	assert.equal(plugin.settings.licenseStatus, "invalid", "an unverifiable key reads as invalid, not valid-pro");
	assert.ok(saved !== null, "the downgrade must be persisted so the brick cannot recur on next load");
	assert.equal(
		(saved as { isPro: boolean }).isPro,
		false,
		"the persisted data.json must record free, or the next load re-reads a Pro entitlement that still won't verify"
	);

	console.log("license-downgrade-onload: a non-verifying stored Pro key downgrades cleanly, onload() survives");
}

void main();
