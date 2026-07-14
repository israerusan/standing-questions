// Manifest/versions contract — the anti-delisting gate. These are the checks Obsidian's
// review runs on manifest.json that eslint-plugin-obsidianmd's `validate-manifest` cannot
// (eslint does not lint the JSON file without a JSON language plugin). It locks the class
// of issue that gets a plugin REJECTED (redundant words in the metadata) plus
// release-version consistency.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	ENGINE_ASSET_SHA256,
	ENGINE_RELEASE_PINNED,
	ENGINE_VERSION,
	isPlaceholderSha256,
} from "../src/shared/engine/engineRelease.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));

// --- Redundant words the review rejects -------------------------------------
// The review bot's validate-manifest rule does a blunt case-insensitive SUBSTRING check for
// "obsidian" and "plugin" in name/description/id — with NO exceptions. This is what blocked
// FlowKit.
for (const key of ["name", "description", "id"]) {
	for (const word of ["obsidian", "plugin"]) {
		assert.ok(
			!new RegExp(word, "i").test(manifest[key]),
			`manifest.${key} must not contain "${word}" (the Obsidian review bot rejects it)`
		);
	}
}

// --- Description shape -------------------------------------------------------
assert.ok(manifest.description.length <= 250, "manifest.description must be <= 250 chars");
assert.ok(manifest.description.endsWith("."), "manifest.description must end with a period");
assert.match(
	manifest.description,
	/^[A-Z][a-z]+ /,
	"manifest.description must start with an action verb (sentence case, no leading article)"
);

// --- Shape -------------------------------------------------------------------
assert.equal(manifest.id, "standing-questions");
assert.ok(/^[a-z0-9-]+$/.test(manifest.id), "manifest.id must be lowercase letters/digits/hyphens");
assert.equal(manifest.id, pkg.name, "manifest.id must equal the package name (portfolio invariant)");
assert.equal(manifest.name, "Standing Questions", "manifest.name is Title Case of the id");
assert.ok(
	manifest.minAppVersion && /^\d+\.\d+\.\d+$/.test(manifest.minAppVersion),
	"manifest.minAppVersion must be set (x.y.z)"
);
assert.equal(manifest.minAppVersion, "1.5.0", "the suite targets 1.5.0 (Vault.process, processFrontMatter)");
assert.ok(manifest.author, "manifest.author must be set");
assert.equal(typeof manifest.isDesktopOnly, "boolean", "manifest.isDesktopOnly must be a boolean");

// isDesktopOnly is FALSE on purpose (DESIGN 2): the whole free tier works on mobile, and
// the vendored EngineHost never statically imports a Node builtin — it reaches for one
// through window.require inside a desktop guard, which is the pattern the obsidianmd
// no-nodejs-modules rule explicitly blesses. Flipping this to true would make the add-on
// invisible in the mobile directory, free tier and all.
assert.equal(manifest.isDesktopOnly, false);

// --- Release consistency (tag == manifest version, listed in versions.json) --
assert.ok(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.version must be x.y.z");
assert.equal(manifest.version, pkg.version, "manifest.json and package.json versions must match");
assert.ok(versions[manifest.version], `versions.json must contain an entry for ${manifest.version}`);
assert.equal(
	versions[manifest.version],
	manifest.minAppVersion,
	"versions.json must map this version to its minAppVersion"
);

// --- The staged community-plugins entry must not drift from the manifest -----
// This file is the literal payload of the obsidian-releases PR. Every field it shares with the
// manifest is cross-checked, because the drift is invisible until it is public.
const staged = JSON.parse(fs.readFileSync(path.join(root, "community-plugins.json"), "utf8"));
const entry = staged.find((row) => row.id === manifest.id);
assert.ok(entry, "community-plugins.json must stage an entry for this add-on");
assert.equal(entry.name, manifest.name);
assert.equal(entry.description, manifest.description);
assert.equal(
	entry.author,
	manifest.author,
	"community-plugins.json author must match manifest.author — it is the byline the directory shows"
);

// --- THE RELEASE GATE: do not sell a key whose only feature cannot run -------
//
// `semanticLeads` is the ONLY Pro feature this add-on has (core/features.mjs), and it needs the
// semantic engine. While `ENGINE_RELEASE_PINNED === false` the engine host REFUSES to download —
// by design, because the asset hashes are still the 64-zero placeholders and downloading an
// executable you cannot verify is the one thing this install flow exists to never do. So the
// "Download engine" button is disabled (SettingsTab), and semantic leads are unreachable.
//
// Tag 1.0.0 in that state and every buyer of the $29 suite key gets, from this add-on, nothing
// they could not have had for free. That is the failure this gate exists to make impossible:
// a 1.x version number is the promise that the product works. Ship 0.x until `pin-engine.mjs`
// has run against a published `sidecar-v*` release, then bump.
const RELEASABLE = /^[1-9]\d*\./.test(manifest.version); // major >= 1
if (RELEASABLE) {
	assert.ok(
		ENGINE_RELEASE_PINNED,
		`manifest.version is ${manifest.version} (a 1.x release) but ENGINE_RELEASE_PINNED is false — ` +
			"the engine cannot be downloaded, so semanticLeads (the only Pro feature) is unreachable for " +
			"every buyer. Run scripts/pin-engine.mjs against a published sidecar release, or ship 0.x."
	);
	assert.notEqual(ENGINE_VERSION, "0.0.0-dev", "a 1.x release must pin a real engine version");
	for (const [target, sha256] of Object.entries(ENGINE_ASSET_SHA256)) {
		assert.ok(
			!isPlaceholderSha256(sha256),
			`a 1.x release must pin a real SHA-256 for ${target} — this one is still the placeholder`
		);
	}
}

// --- No static import of a Node builtin anywhere in src ----------------------
// A static `import "child_process"` compiles to a TOP-LEVEL require() in the CJS bundle and
// crashes on mobile before onload() ever runs — regardless of what isDesktopOnly says. The
// vendored EngineHost is the only file that touches Node, and it does so through
// window.require inside a Platform guard.
const BUILTINS = ["child_process", "fs", "https", "http", "os", "path", "crypto", "net"];
for (const file of walk(path.join(root, "src"))) {
	if (!file.endsWith(".ts") && !file.endsWith(".mjs")) continue;
	const source = fs.readFileSync(file, "utf8");
	for (const builtin of BUILTINS) {
		const staticImport = new RegExp(`^\\s*import\\s[^;]*from\\s+["'](node:)?${builtin}["']`, "m");
		assert.ok(
			!staticImport.test(source),
			`${path.relative(root, file)} statically imports "${builtin}" — that becomes a top-level require() and crashes mobile`
		);
	}
}

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else yield full;
	}
}

console.log("ok  manifest-contract.test.mjs");
