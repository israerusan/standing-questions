/**
 * THE ENGINE-ABSENT PATH.
 *
 * This add-on downloads and runs a native binary. Almost nobody will ever do that: they will
 * be on a phone, or on the free tier, or on a desktop where they never clicked the button. So
 * the path with NO ENGINE is the one the add-on actually lives on, and it is the one whose
 * regressions nobody would notice until a one-star review explains them.
 *
 * Everything below runs the SHIPPED code against the obsidian stub, whose `Platform.isDesktop`
 * is false — i.e. the mobile path. It asserts three things:
 *
 *   1. Nothing is spawned, published to the window, or downloaded. Not "we did not call
 *      install()" — there is no host, and no global to leak.
 *   2. The free product is COMPLETE: questions, statuses, the DAG with upward propagation, the
 *      board's tree order, and real keyword leads that can be written into a question note.
 *   3. The settings tab says so, honestly, instead of showing a dead button.
 *
 * It then flips the semantic path on with a fake engine to prove the threshold gate is wired to
 * the same UI — the free tier is not a different product, it is a weaker matcher.
 *
 * (Everything is inside main(). The test bundle is CJS, where esbuild rejects top-level await.)
 */
import assert from "node:assert";
import { Setting, TFile, noticeTexts, notices, type FakeEl } from "obsidian";
import { EngineBroker } from "../src/shared/engine/EngineBroker";
import { QuestionIndex } from "../src/questionIndex";
import { LeadPipeline } from "../src/leadPipeline";
import { DEFAULT_SETTINGS, type StandingQuestionsSettings } from "../src/settings";
import { DEFAULT_LEAD_OPTIONS } from "../src/core/leads.mjs";
import { StandingQuestionsSettingTab } from "../src/ui/SettingsTab";

/* ------------------------------------------------------------------ a vault -- */

interface Note {
	path: string;
	frontmatter?: Record<string, unknown>;
	body?: string;
	links?: string[];
	headings?: string[];
	ctime?: number;
}

function makeVault(notes: Note[]) {
	const files = new Map<string, TFile>();
	const bodies = new Map<string, string>();
	const caches = new Map<string, unknown>();
	const resolvedLinks: Record<string, Record<string, number>> = {};

	for (const note of notes) {
		const file = new TFile();
		file.path = note.path;
		file.basename = note.path.replace(/^.*\//, "").replace(/\.md$/, "");
		file.extension = "md";
		file.stat = { ctime: note.ctime ?? 1_700_000_000_000, mtime: 1_700_000_000_000, size: 0 };
		files.set(note.path, file);
		bodies.set(note.path, note.body ?? "");
		caches.set(note.path, {
			frontmatter: note.frontmatter,
			headings: (note.headings ?? []).map((heading) => ({ heading })),
		});
		resolvedLinks[note.path] = Object.fromEntries((note.links ?? []).map((link) => [link, 1]));
	}

	const app = {
		vault: {
			getMarkdownFiles: () => [...files.values()],
			getFileByPath: (path: string) => files.get(path) ?? null,
			cachedRead: (file: TFile) => Promise.resolve(bodies.get(file.path) ?? ""),
			process: (file: TFile, fn: (data: string) => string) => {
				bodies.set(file.path, fn(bodies.get(file.path) ?? ""));
				return Promise.resolve(bodies.get(file.path) ?? "");
			},
		},
		metadataCache: {
			getFileCache: (file: TFile) => caches.get(file.path),
			// Link text resolves by basename, the way Obsidian's shortest-path resolution does.
			getFirstLinkpathDest: (linkpath: string) =>
				[...files.values()].find(
					(file) => file.basename === linkpath || file.path === `${linkpath}.md`
				) ?? null,
			resolvedLinks,
			fileToLinktext: (file: TFile) => file.basename,
		},
		workspace: {
			getLeaf: () => ({ openFile: () => Promise.resolve() }),
			getLeavesOfType: () => [],
		},
	};

	return { app, bodies, files, resolvedLinks };
}

const settings = (over: Partial<StandingQuestionsSettings> = {}): StandingQuestionsSettings => ({
	...DEFAULT_SETTINGS,
	...over,
});

const VAULT: Note[] = [
	{
		path: "Questions/Why did we drop the CRDT plan.md",
		frontmatter: { type: "question", status: "open" },
		body: "# Why did we drop the CRDT plan?\n\nWe never wrote down the reason.",
		links: ["Decisions/Storage.md"],
		ctime: Date.parse("2026-01-14T00:00:00Z"),
	},
	{
		path: "Questions/Merge cost.md",
		frontmatter: { type: "question", status: "answered" },
		body: "# What does a merge cost?\n\nparent:: [[Why did we drop the CRDT plan]]\n",
	},
	{
		path: "Questions/Replica count.md",
		frontmatter: { type: "question", status: "open" },
		body: "# How many replicas?\n\nparent:: [[Why did we drop the CRDT plan]]\n",
	},
	{ path: "Decisions/Storage.md", body: "The storage decision." },
	{
		path: "2026-07-14 CRDT merge benchmarks.md",
		// Comfortably over minLeadChars (600). A stub is never worth interrupting anyone about,
		// and a fixture that sits on the boundary tests the boundary rather than the feature.
		body:
			"# CRDT merge benchmarks\n\n" +
			"The merge cost scaled with the number of replicas, which is why the plan was dropped. ".repeat(
				10
			),
		headings: ["Results"],
		links: ["Decisions/Storage.md"],
	},
];

async function main(): Promise<void> {
	/* --------------------------------------- 1. nothing is spawned on mobile -- */

	{
		const { app } = makeVault([]);
		const host = EngineBroker.acquire(app as never, "standing-questions", {});
		assert.equal(host, null, "there is no engine host off-desktop — not a disabled one, none");
		assert.deepEqual(EngineBroker.refs(), [], "and nothing was published to the window realm");
		assert.equal(EngineBroker.peek(), null);

		// release() must be safe even though we never acquired — onunload() calls it unconditionally.
		EngineBroker.release("standing-questions");
	}

	/* ---------------------------- 2. the free product is complete without it -- */

	const free = makeVault(VAULT);
	const freeSettings = settings();
	const index = new QuestionIndex(free.app as never, freeSettings);
	await index.rebuild();

	assert.equal(index.all().length, 3, "three question notes, found from frontmatter alone");
	assert.ok(index.isQuestion("Questions/Why did we drop the CRDT plan.md"));
	assert.ok(!index.isQuestion("Decisions/Storage.md"));

	// The inline `parent::` form, resolved through Obsidian's own link resolution.
	assert.deepEqual(index.get("Questions/Merge cost.md")?.parents, ["Questions/Why did we drop the CRDT plan.md"]);

	// The DAG propagated: CRDT has one answered child and one open one ⇒ partial. The NOTE still
	// says `open`, and pendingChanges() is exactly what the writer would write back.
	assert.equal(index.get("Questions/Why did we drop the CRDT plan.md")?.status, "open", "what the note says");
	assert.equal(index.get("Questions/Why did we drop the CRDT plan.md")?.propagated, "partial", "what its sub-questions say");
	assert.deepEqual(
		index.pendingChanges().map((change) => `${change.id}:${change.from}->${change.to}`),
		["Questions/Why did we drop the CRDT plan.md:open->partial"]
	);

	// The board's tree order: the parent first, then its children, indented.
	assert.deepEqual(
		index.tree().map((row) => [row.node.id, row.depth]),
		[
			["Questions/Why did we drop the CRDT plan.md", 0],
			["Questions/Merge cost.md", 1],
			["Questions/Replica count.md", 1],
		]
	);
	assert.deepEqual(index.cycles(), []);

	assert.deepEqual(
		index.unanswered().map((record) => record.path).sort(),
		["Questions/Replica count.md", "Questions/Why did we drop the CRDT plan.md"],
		"an answered question is never offered a lead; a partial one still is"
	);

	/* ------ 3. leads with NO engine — and the engine is never even touched ----- */

	/** Any access to this is a bug: on the free/mobile path the engine must not be consulted. */
	const forbiddenEngine = {
		query: () => {
			throw new Error("the engine was queried on the engine-absent path");
		},
		sync: () => {
			throw new Error("the engine was synced on the engine-absent path");
		},
	};

	notices.length = 0;
	const freeLeads = new LeadPipeline({
		app: free.app as never,
		settings: freeSettings,
		index,
		engineIndex: forbiddenEngine as never,
		canUseSemanticPro: () => false,
	});

	const found = await freeLeads.run("2026-07-14 CRDT merge benchmarks.md", false);
	assert.ok(found > 0, "the free keyword matcher found a lead with no engine, no license, no network");

	const told = noticeTexts().join(" | ");
	assert.ok(told.includes("Why did we drop the CRDT plan"), "the notice names the question");
	assert.ok(
		told.includes("a question you asked in January"),
		"...and when it was asked, which is the whole emotional point"
	);
	assert.ok(told.includes("Add lead"), "and it offers an action rather than just interrupting");

	// Notify-only: the question note has NOT been touched.
	assert.ok(
		!(free.bodies.get("Questions/Why did we drop the CRDT plan.md") ?? "").includes("## Leads"),
		"nothing is written into a note without a click — auto-append is off by default"
	);

	// Now press the button the user would press.
	const fragment = notices.find(
		(notice) => typeof notice !== "string" && notice.text().includes("Add lead")
	) as FakeEl;
	const addButton = fragment.find((el) => el.tag === "button" && el.textContent === "Add lead");
	assert.ok(addButton, "the notice really has a button in it");
	addButton.click();
	await Promise.resolve();
	await Promise.resolve();

	const question = free.bodies.get("Questions/Why did we drop the CRDT plan.md") ?? "";
	assert.ok(question.includes("## Leads"), "clicking it appends the lead under ## Leads");
	assert.ok(question.includes("[[2026-07-14 CRDT merge benchmarks]]"));
	assert.ok(question.startsWith("# Why did we drop the CRDT plan?"), "and the note is otherwise untouched");

	// A question is never a lead for another question.
	assert.equal(await freeLeads.run("Questions/Why did we drop the CRDT plan.md", false), 0);
	// A short note is not worth interrupting anyone about.
	assert.equal(await freeLeads.run("Decisions/Storage.md", false), 0);

	/* ------------------- 4. the threshold gate, on the semantic path ----------- */

	{
		const vault = makeVault(VAULT);
		const proSettings = settings({ isPro: true, keywordLeadsEnabled: false });
		const proIndex = new QuestionIndex(vault.app as never, proSettings);
		await proIndex.rebuild();

		let score = 0.62; // "Related", but not an answer. DESIGN 6.5's 0.60 bar would fire here.
		const fakeEngine = {
			query: () =>
				Promise.resolve([
					{
						i: 0,
						hits: [
							{
								key: "k",
								note: "Questions/Why did we drop the CRDT plan.md",
								ord: 0,
								score,
								heading: "",
								preview: "the merge cost scaled with the number of replicas",
							},
						],
					},
				]),
		};

		const pipeline = new LeadPipeline({
			app: vault.app as never,
			settings: proSettings,
			index: proIndex,
			engineIndex: fakeEngine as never,
			canUseSemanticPro: () => true,
		});

		notices.length = 0;
		assert.equal(
			await pipeline.run("2026-07-14 CRDT merge benchmarks.md", false),
			0,
			"0.62 is below the shipped 0.75 bar — the user is not interrupted"
		);
		assert.deepEqual(notices, []);

		score = 0.81;
		notices.length = 0;
		assert.equal(await pipeline.run("2026-07-14 CRDT merge benchmarks.md", false), 1, "0.81 is a real lead");
		assert.ok(noticeTexts().join(" ").includes("0.81"), "and the score is shown, so the user can calibrate");
		assert.ok(
			!(vault.bodies.get("Questions/Why did we drop the CRDT plan.md") ?? "").includes("## Leads"),
			"still notify-only: even a strong semantic lead is not written without a click"
		);
	}

	/* ----------- 5. the settings tab tells the truth about the engine ---------- */

	{
		const { app } = makeVault(VAULT);
		const tabSettings = settings();
		const tabIndex = new QuestionIndex(app as never, tabSettings);
		await tabIndex.rebuild();

		const plugin = {
			app,
			settings: tabSettings,
			licenseError: undefined,
			index: tabIndex,
			engine: null, // mobile / no engine
			engineStatus: null,
			refreshLicense: () => Promise.resolve(false),
			refreshEngineStatus: () => Promise.resolve(null),
			flushPendingSave: () => Promise.resolve(),
			saveSettings: () => Promise.resolve(),
			queueSave: () => undefined,
			propagateStatuses: () => Promise.resolve(0),
		};

		Setting.reset();
		const tab = new StandingQuestionsSettingTab(plugin as never);
		tab.display();

		const text = tab.containerEl.text();
		assert.ok(
			text.includes("The semantic engine runs on desktop only"),
			"it says so plainly, instead of showing a button that cannot work"
		);
		assert.ok(
			text.includes("questions, statuses, sub-questions, the board, and keyword leads"),
			"...and it names what DOES work here, so a mobile user does not think the add-on is broken"
		);

		const names = Setting.instances.map((setting) => setting.name);
		assert.ok(!names.includes("Download engine"), "no download row exists off-desktop");
		assert.ok(!names.includes("Remove engine"));
		assert.ok(names.includes("License key"), "but the license, the questions and the leads are all here");
		assert.ok(names.includes("Keyword and link leads"));
		assert.ok(names.includes("Propagate statuses upward"));

		// The Pro rows are visible and LOCKED — never absent (which reads as a bug) and never live.
		const semantic = Setting.instances.find((setting) => setting.name === "Semantic lead detection");
		assert.ok(semantic, "the Pro feature is shown to a free user");
		assert.equal(semantic.controls().length, 0, "with no working control");
		assert.ok(semantic.settingEl.hasClass("standing-questions-setting-locked"));
		assert.ok(semantic.descEl.text().includes("Upgrade to Pro"), "and a way to buy it");
	}

	/* ------------------------- 6. the shipped thresholds ---------------------- */

	assert.equal(DEFAULT_SETTINGS.leadMinScore, DEFAULT_LEAD_OPTIONS.leadMinScore);
	assert.equal(DEFAULT_SETTINGS.leadMinScore, 0.75);
	assert.equal(DEFAULT_SETTINGS.leadAutoAppend, false);
	assert.equal(DEFAULT_SETTINGS.semanticLeadsEnabled, true, "on, but gated on Pro + an engine");
}

/** test/run.mjs awaits this, so a rejected assertion fails the run at THIS file. */
export const done = main();
