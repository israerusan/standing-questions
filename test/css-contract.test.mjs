// The `id == package name == CSS prefix` invariant, enforced.
//
// Five add-ons in this portfolio are built from one shared core and a lot of copy-paste between
// sibling repos. Copy-paste is how `src/ui/pro/ProUpsellModal.ts` arrived here from note-decay
// still building `note-decay-upsell-lead` — a class name that exists in NO stylesheet in this
// repo, so the modal rendered unstyled, and nothing failed. A wrong class name cannot throw. It
// just quietly looks broken, in a surface a paying user is the most likely person to see.
//
// So the check is mechanical, and it runs on every build:
//
//   1. No class name belonging to a SIBLING add-on may appear anywhere in src/ or styles.css.
//   2. Every `standing-questions-*` / `second-read-*` class the source builds must be defined
//      in styles.css.
//
// (1) catches the copy-paste at the moment it lands. (2) catches the half-done rename — the
// failure mode where someone de-brands the TypeScript and forgets the stylesheet.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** This add-on's own prefix, and the suite-wide prefix for shared UI (the engine modal). */
const OWN_PREFIXES = ["standing-questions-", "second-read-"];

/** The other add-ons this repo is copy-pasted to and from. None of these belongs here. */
const SIBLING_PREFIXES = [
	"note-decay-",
	"effort-index-",
	"prior-art-",
	"unwritten-",
	"vault-spotlight-",
	"note-doctor-",
	"invoice-forge-",
	"attachment-manager-",
	"vault-router-",
	"prose-lens-",
];

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else yield full;
	}
}

const sources = [...walk(path.join(root, "src"))].filter(
	(file) => file.endsWith(".ts") || file.endsWith(".mjs")
);
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

// --- 1. No sibling add-on's brand, in the source or in the stylesheet --------
for (const file of [...sources, path.join(root, "styles.css")]) {
	const source = fs.readFileSync(file, "utf8");
	for (const prefix of SIBLING_PREFIXES) {
		const hit = new RegExp(`${prefix}[a-z0-9-]+`).exec(source);
		assert.ok(
			!hit,
			`${path.relative(root, file)} references "${hit?.[0]}" — that is another add-on's CSS ` +
				`class. It is dead on arrival here: no stylesheet in this repo defines it, so whatever ` +
				`builds it renders unstyled. De-brand the copy-paste, or delete it.`
		);
	}
}

// --- 2. Every class the source builds is defined in the stylesheet ----------
const defined = new Set([...styles.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]));

// Only CLASS call sites — `cls:`, addClass(...), classList.add(...). Scanning for the bare prefix
// would also match `second-read-engine`, the name of the install DIRECTORY (core/enginePaths.mjs),
// which is not a class and is not in any stylesheet.
const CLASS_SITE =
	/(?:cls:\s*|(?:add|remove|toggle|has)Class\(\s*|classList\.(?:add|remove|toggle|contains)\(\s*)["']([^"']+)["']/g;

const used = new Map(); // class -> first file that builds it
for (const file of sources) {
	const source = fs.readFileSync(file, "utf8");
	for (const [, value] of source.matchAll(CLASS_SITE)) {
		for (const cls of value.split(/\s+/).filter(Boolean)) {
			if (!OWN_PREFIXES.some((prefix) => cls.startsWith(prefix))) continue; // e.g. "mod-cta"
			if (!used.has(cls)) used.set(cls, file);
		}
	}
}

assert.ok(used.size > 10, "sanity: the class scan found almost nothing, so it is not scanning");

for (const [cls, file] of used) {
	assert.ok(
		defined.has(cls),
		`${path.relative(root, file)} builds the class "${cls}", which styles.css does not define — ` +
			"it will render unstyled. Add the rule, or stop building the element."
	);
}

console.log(`ok  css-contract.test.mjs (${used.size} classes, all defined)`);
