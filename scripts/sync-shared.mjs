#!/usr/bin/env node
/**
 * Sync the vendored shared core in a plugin repo against the canonical
 * obsidian-plugin-core checkout.
 *
 * Run from a plugin repo root (each plugin vendors a copy of this script):
 *   node scripts/sync-shared.mjs           # copy canonical -> src/shared/
 *   node scripts/sync-shared.mjs --check   # exit 1 if the vendored copy drifted
 *
 * The canonical checkout is expected at ../obsidian-plugin-core relative to
 * the plugin repo, or wherever PLUGIN_CORE_PATH points. When it is absent
 * (CI, fresh clones), both modes succeed silently — the vendored copies are
 * committed, so builds never depend on the canonical repo being present.
 */
import fs from "fs";
import path from "path";

const repoRoot = process.cwd();
const canonical =
	process.env.PLUGIN_CORE_PATH || path.resolve(repoRoot, "..", "obsidian-plugin-core");
const check = process.argv.includes("--check");

/** [canonical-relative, plugin-relative] pairs kept in sync. */
const FILES = [
	["shared/verifyLicense.mjs", "src/shared/verifyLicense.mjs"],
	["shared/verifyLicense.d.mts", "src/shared/verifyLicense.d.mts"],
	["shared/suiteLicense.mjs", "src/shared/suiteLicense.mjs"],
	["shared/suiteLicense.d.mts", "src/shared/suiteLicense.d.mts"],
	["shared/revokedLicenses.mjs", "src/shared/revokedLicenses.mjs"],
	["shared/revokedLicenses.d.mts", "src/shared/revokedLicenses.d.mts"],
	["shared/licenseTransition.mjs", "src/shared/licenseTransition.mjs"],
	["shared/licenseTransition.d.mts", "src/shared/licenseTransition.d.mts"],
	["shared/featureGates.mjs", "src/shared/featureGates.mjs"],
	["shared/featureGates.d.mts", "src/shared/featureGates.d.mts"],
	["shared/hash.mjs", "src/shared/hash.mjs"],
	["shared/hash.d.mts", "src/shared/hash.d.mts"],
	["shared/engine/protocol.mjs", "src/shared/engine/protocol.mjs"],
	["shared/engine/protocol.d.mts", "src/shared/engine/protocol.d.mts"],
	["shared/engine/chunk.mjs", "src/shared/engine/chunk.mjs"],
	["shared/engine/chunk.d.mts", "src/shared/engine/chunk.d.mts"],
	["shared/engine/installPlan.mjs", "src/shared/engine/installPlan.mjs"],
	["shared/engine/installPlan.d.mts", "src/shared/engine/installPlan.d.mts"],
	["shared/engine/engineRelease.mjs", "src/shared/engine/engineRelease.mjs"],
	["shared/engine/engineRelease.d.mts", "src/shared/engine/engineRelease.d.mts"],
	["shared/engine/EngineHost.ts", "src/shared/engine/EngineHost.ts"],
	["shared/engine/EngineBroker.ts", "src/shared/engine/EngineBroker.ts"],
	["shared/engine/EngineInstallModal.ts", "src/shared/engine/EngineInstallModal.ts"],
	["shared/signals/signalsAggregate.mjs", "src/shared/signals/signalsAggregate.mjs"],
	["shared/signals/signalsAggregate.d.mts", "src/shared/signals/signalsAggregate.d.mts"],
	["shared/signals/SignalStore.ts", "src/shared/signals/SignalStore.ts"],
	["shared/signals/SignalsBroker.ts", "src/shared/signals/SignalsBroker.ts"],
	["scripts/sync-shared.mjs", "scripts/sync-shared.mjs"],
];

/** Compare content, not line endings — git autocrlf checkouts differ per OS. */
const normalize = (text) => text.replace(/\r\n/g, "\n");

if (!fs.existsSync(canonical)) {
	console.log(`sync-shared: canonical repo not found at ${canonical} — skipping.`);
	process.exit(0);
}

let drifted = 0;
for (const [from, to] of FILES) {
	const src = path.join(canonical, from);
	const dest = path.join(repoRoot, to);
	if (!fs.existsSync(src)) {
		console.error(`sync-shared: missing canonical file ${src}`);
		process.exit(1);
	}
	const want = fs.readFileSync(src, "utf8");
	const have = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
	if (have !== null && normalize(want) === normalize(have)) continue;
	if (check) {
		console.error(`sync-shared: DRIFT in ${to} (canonical: ${from})`);
		drifted++;
	} else {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, want);
		console.log(`sync-shared: updated ${to}`);
	}
}

if (check && drifted > 0) {
	console.error(`sync-shared: ${drifted} file(s) drifted — run "npm run sync:shared" to update.`);
	process.exit(1);
}
console.log(check ? "sync-shared: vendored copies match canonical." : "sync-shared: done.");
