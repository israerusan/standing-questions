# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-07-14

Release candidate. The free tier is complete; the Pro semantic feature is gated and inert until
the semantic engine has a published build.

**This is deliberately not 1.0.0.** `semanticLeads` is the only Pro feature this add-on has, and
it cannot run until `shared/engine/engineRelease.mjs` pins a real engine release
(`ENGINE_RELEASE_PINNED === false` today, and the engine host refuses to download a binary whose
checksum it cannot verify). Tagging 1.0.0 now would sell a $29 key whose single feature is
unreachable. `test/manifest-contract.test.mjs` enforces this: the version cannot cross into 1.x
while the engine is unpinned, and the build goes red if it does.

### Added

- **Questions as first-class objects.** A note with `type: question` in its frontmatter has a
  state (`open` / `partial` / `answered`), appears on the question board, and is matched
  against every note you write. An unrecognised status value is treated as an **open** question
  with a typo — never as "not a question", because a question that silently stops being one is
  a notice that silently never fires.
- **Sub-questions, as a DAG.** A parent is declared in frontmatter (`parent: "[[X]]"`) or as an
  inline field (`parent:: [[X]]`) — Dataview is not a dependency, so both forms are parsed here.
  Answering every sub-question answers the parent; answering some makes it partial. Propagation
  only ever moves a question **forward**: an explicit `status: answered` is never silently
  reopened by a sub-question nobody closed.
- **`parent::` loops cannot hang the add-on.** `A → B → A` is one typo away and would make a
  naive post-order walk run for ever. Loops are found with an iterative Tarjan (no recursion, so
  a pathological vault cannot blow the stack either), reported on the board and in settings, and
  every question inside one keeps exactly the status the user gave it.
- **The question board** — open / partial / answered, tree-indented by sub-question, showing the
  *propagated* status and flagging any note whose frontmatter has not caught up.
- **Keyword and link leads (free, and mobile).** A new note is matched against the open questions
  on shared significant words (stopword-filtered, suffix-stemmed; two shared tokens minimum,
  because one is a coincidence) and on **links they have in common** — the signal keyword matching
  normally cannot see, and semantic search does not either: the vault's own structure saying two
  notes are about the same thing in different words.
- **Leads are notify-only.** A lead raises a notice naming the question and *when it was asked*,
  with an "Add lead" button. Nothing is written into any note until that button is pressed. The
  writer is idempotent, so a note that keeps getting edited never accretes the same lead twice,
  and it preserves everything after the `## Leads` section.
- **Second Read Pro licensing.** One offline-verified Ed25519 key unlocks Pro in all five Second
  Read add-ons. Revocation is checked before the signature, so a leaked key can be killed without
  rotating the keypair and revoking Pro for every paying customer.

### Gated, not yet available

- **Semantic lead detection** is Pro + semantic-engine. The pipeline, the consent modal, the
  install/verify/extract/spawn flow, the update and remove buttons, the engine log and the
  bring-your-own-binary fallback are all wired. What is missing is a published engine release to
  pin: `shared/engine/engineRelease.mjs` reports `ENGINE_RELEASE_PINNED === false`, and the shared
  engine host **refuses to download an executable it cannot verify a checksum for**. So the
  "Download engine" button is disabled and says why, rather than failing at the user.

### Security posture (the things this add-on does that you cannot see)

- Nothing is downloaded at load. Ever. The only caller of the installer is the confirm handler of
  a modal that names the URL, the version, the SHA-256 and the install path, and states that a
  program will be run.
- The checksum is verified **before** the archive is extracted and **before** any exec bit is set.
  On a mismatch the file is deleted and nothing runs.
- The engine is installed **outside the vault**, in the platform's application-data directory.
- The engine process is killed when the last Second Read add-on unloads (a shared refcount — it is
  never killed out from under Prior Art, which may be using the same one), when Obsidian's process
  ends, and after ten idle minutes.
- No Node built-in is ever statically imported: a static `import "fs"` becomes a top-level
  `require()` in the CJS bundle and crashes every mobile user on load, whatever `isDesktopOnly`
  says. `test/manifest-contract.test.mjs` fails the build if one appears.

[0.9.0]: https://github.com/israerusan/standing-questions/releases/tag/0.9.0
