# Standing Questions

The questions you asked months ago, and the notes that quietly answered them.

Every vault has open questions in it. *Why did we drop the CRDT plan? How long should onboarding take? Is the storage rewrite worth it?* You write them down, and then you keep writing — and eight weeks later you write the note that answers one of them, and you never notice, because nothing in Obsidian connects a note to a question you asked in January.

Standing Questions makes a question a first-class object: it has a state, it has sub-questions, and it watches for its own answer.

> Standing Questions never edits your notes without being asked. Leads are **notify-only** by default: it tells you, and you click. The only thing it ever writes on its own is a `status:` line in a question's frontmatter, when its sub-questions are all answered — and that is a toggle you can turn off.

## How it works

Add two lines to a note:

```yaml
---
type: question
status: open        # open | partial | answered
---
```

That note is now a question. It appears on the **question board**, it is watched, and every note you write is matched against it.

### Sub-questions

A question can be part of a bigger one. Say so in frontmatter, or inline:

```yaml
parent: "[[Why did we drop the CRDT plan?]]"
```

```md
parent:: [[Why did we drop the CRDT plan?]]
```

Then the states propagate **upward**:

| Sub-questions | The parent becomes |
| --- | --- |
| all answered | **answered** |
| some answered or part-answered | **partial** |
| none moved | untouched |

Propagation only ever moves a question **forward**. If you wrote `status: answered` on a parent, a sub-question you never got round to closing will not silently reopen your answer.

**A `parent::` loop cannot hang it.** `A → B → A` is one typo away, and a loop would make a naive walk run for ever. Loops are detected, reported on the board and in settings, and every question inside one keeps exactly the status you gave it.

### Leads

When you save a note, Standing Questions asks: *does this answer anything?*

If it does, you get a notice — **"This may answer a question you asked in January: Why did we drop the CRDT plan?"** — with a button. Press it and the lead is written into the question:

```md
## Leads
- [[2026-07-14 Storage benchmarks]] — 0.81 · "…the merge cost scaled with the number of replicas…"
```

Nothing is written until you press it. (There is an opt-in setting that appends very strong leads without asking. It is off.)

## What you get

### Free — all of it

- **Questions as objects**: frontmatter contract, three states, a question board.
- **Sub-questions**, with status propagated upward, and loop detection.
- **Keyword and link leads** — matches a new note against your open questions on shared significant words and on links they have in common. The link signal is the one keyword matching normally cannot see: *you and this question both link to the same note.*
- Works on **mobile**. No engine, no license, no network, no note limit, no nag screen.

### Pro — $29 one-time, unlocks all five Second Read add-ons

- **Semantic lead detection.** The note that answers *"Why did we drop the CRDT plan?"* without ever using the word CRDT. Your note is compared against every open question **by meaning**, not by keyword.

Pro needs the local semantic engine (below). One key unlocks Pro in all five Second Read add-ons: Note Decay, Standing Questions, Effort Index, Prior Art, and Unwritten. Licenses are verified **offline** with an Ed25519 signature built into the add-on. No account, no server, no network request.

## Threshold, and why it is set where it is

The lead threshold is a **cosine similarity**, and it defaults to **0.75**.

That is deliberately conservative. Below about 0.6, notes that merely *share a subject* start matching — and an add-on that interrupts you about those gets muted within a day, and a muted add-on has no features. At 0.75 a lead is nearly always a real one. It is a slider; if you would rather see more, lower it.

## Disclosures

Please read these before installing. They are the things this add-on does that you cannot see.

### The Pro features download and run a program — and only if you ask

Semantic lead detection needs a local semantic engine: a self-contained program that runs on your computer, embeds your notes locally, and **opens no network connections of its own**.

- **Nothing is downloaded unless you click "Download engine" in settings**, and confirm a dialog that names the exact URL, the version, the SHA-256 checksum, and the directory it will be installed into, and states plainly that a program will be run.
- The download is **verified against a checksum built into this add-on before anything is extracted, before anything is made executable, and before anything is run.** If it does not match, the file is deleted and nothing executes.
- **It is never updated silently.** If a newer engine exists, you get an "Update engine" button. You click it, or you do not.
- **This add-on accesses files outside your vault.** The engine is installed in your system's application-data folder — `%LOCALAPPDATA%\second-read-engine` on Windows, `~/Library/Application Support/second-read-engine` on macOS, `~/.local/share/second-read-engine` on Linux — and its index lives there too. It is **never** written into your notes folder. (Two reasons: Obsidian Sync and Dropbox replicate `.obsidian/plugins/**`, and you do not want 100 MB of it on your phone; and a note-taking app that drops an executable into your documents folder is exactly the pattern that makes security software escalate.)
- The engine runs only while Obsidian is open. It is killed when the last Second Read add-on unloads, it dies when Obsidian's process ends, and it exits by itself after ten idle minutes.
- **Source: [github.com/israerusan/second-read-engine](https://github.com/israerusan/second-read-engine).** It is open, and the release is built in public CI.
- **Desktop only.** On mobile there is no engine and no download button — and the whole free tier still works.
- **If your system refuses to run a downloaded program** (antivirus quarantine, a `noexec` mount, Flatpak confinement), point the add-on at an engine binary you installed yourself: **Settings → Semantic engine → Path to an existing engine**. The download is a convenience, not the mechanism.

### What is sent where

Nothing leaves your machine. The engine receives the text of your notes over a pipe — not a network socket — and returns numbers. The license check is a signature verification done offline. This add-on makes exactly one kind of outbound request in its entire life: downloading the engine from GitHub, after you click the button.

### What it writes

- A `status:` line in a question's frontmatter, when its sub-questions have moved it. Toggleable, and it only ever writes when the value actually changes.
- A `## Leads` line in a question's note — **only when you press "Add lead"**, unless you opt in to auto-append.
- Nothing else, ever.

## Commands

| Command | What it does |
| --- | --- |
| Open question board | Open / partial / answered, tree-indented by sub-question. |
| Create a question note | The title is the question. |
| Mark this question answered | On a question note. |
| Propagate question statuses | Push sub-question answers up, now. |
| Find leads for open questions | On any other note. Works free (keyword) and Pro (semantic). |

No default hotkeys — bind your own in Settings → Hotkeys.

## Install

Not yet in the community directory. To install manually, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/standing-questions/` and enable it in Settings → Community plugins.

## Development

```bash
npm install
npm run sync:shared     # vendor the shared Second Read core
npm run lint            # typecheck + the review bot's own eslint ruleset
npm test                # lint + drift check + the whole suite
npm run build           # production bundle
npm run install:vault -- <path to a vault>
```

`src/shared/` is **vendored** from [obsidian-plugin-core](https://github.com/israerusan/obsidian-plugin-core) and must never be edited here — `npm test` fails on drift.

## License

MIT. See [LICENSE](LICENSE).
