# Script engine: design proposal

This document is a design proposal. It describes a possible user scripting
engine for nueon. Nothing here is implemented and nothing here changes code.
The goal is to lay out the choices, each with a recommendation and reasons, so
the choices can be reviewed before any code is written.

Status: proposal, not a decision.

## 1. Use cases, ranked

These are ordered by how useful they are likely to be, most useful first.

1. Generating words from rules: run a script that produces a batch of new
   words, for example applying a set of syllable and sound rules to a list of
   roots.
2. Bulk-transforming tables: rename words, merge or split senses, add or
   remove a tag value across a whole table, normalize casing, or apply a sound
   change to every wordname in a table.
3. Custom inflection rules: rules that are too specific for the existing
   SCA and morphology rule engines, for example irregular paradigms or
   conditional allomorphy that needs branching.
4. Lint checks: report words that break a rule, notes that reference missing
   words, or tables with inconsistent data, without changing anything.
5. Import and export transforms: reshape a file on import or export, for
   example converting a third party word list into a table.

Which of these need a full scripting language:

- Word generation and bulk transforms can be done today with the SCA engine
  (ordered sound changes) plus the existing apply-to-table action. Extending
  the SCA with a small set of operations (a "replace", a "filter", a "map")
  could cover most of use cases 1 and 2 without a scripting language.
- Custom inflection rules partly fit the existing morphology paradigm engine,
  but branching and irregular exceptions do not. This is the first use case
  that clearly benefits from real code.
- Lint checks are read only and are a natural first target for scripts,
  because they cannot damage data.
- Import and export transforms are the most open ended and are the strongest
  argument for a general language, but they are also the least common.

Recommendation: build the scripting engine around the read only and
proposed-change model first (lint checks and transforms with a preview), and
treat word generation as a first-class example, not as the reason to build it.

## 2. Language options

Three candidates, compared on size, sandboxing, how they embed in Rust and
Tauri, and how familiar they are to users.

### Rhai

- Small, embedded scripting language for Rust, no external runtime.
- Sandboxing is good: no filesystem or network access by default, and it is
  easy to limit instructions and operations.
- Compiles and runs inside the Rust process with no FFI.
- Familiarity: low. Rhai has its own syntax, so users have to learn it.
- Good fit for the sandbox-first requirements.

### Lua via mlua

- Lua is a small, widely known language, and mlua embeds it in Rust.
- Sandboxing requires setting up a restricted environment (no os, io, or
  require modules) and guarding resource use.
- Familiarity: high for some users, low for others.
- Slightly more work to sandbox than Rhai, and the FFI to Lua values is more
  manual.

### JavaScript via QuickJS

- JavaScript is the most familiar language overall.
- QuickJS is small and can run in a sandboxed way, but embedding it and
  limiting resources is more work than Rhai or Lua.
- The FFI and object bridging is more involved.
- Familiarity: highest.

Recommendation: Rhai. The sandbox-first requirements and small footprint match
Rhai well, and the API can be kept simple enough that the unfamiliar syntax is
not a big cost. If familiarity wins out later, Lua via mlua is the fallback.
JavaScript via QuickJS is not worth the extra sandboxing and bridging work.

## 3. Sandbox

Security is the first requirement, because workspaces can be shared.

- No filesystem access, no network access, no process spawning, no environment
  access by default.
- Limit instructions or execution time per run. Rhai exposes an operations
  budget; a time limit is the backup.
- Limit memory and returned data size so a script cannot exhaust the app.
- On a runaway or exhausted budget, stop the script and show an error with the
  script name and the limit it hit.
- Scripts run on the backend (the Rust core) so the sandbox lives in one
  place, not in the webview.

Recommendation: enforce all limits on the Rust side, and do not expose any
escape hatch, even behind a settings toggle, in the first version.

## 4. API surface

The API is deliberately read heavy and write light.

- Read access: words, tables, config, and notes. A script can list tables,
  read words and their fields, read config, and read note contents.
- Writes are not direct. A script returns a list of proposed changes (rename a
  word, set a field, create a word, rewrite a note). The app shows those
  changes and the user applies them.
- Applying goes through the existing undo and history system, so any apply is
  one undo step, exactly like the SCA apply-to-table action.
- Every run has a dry run preview first. The script runs, produces proposed
  changes, and the app shows a before and after without writing anything. The
  user then chooses apply or discard.

Recommendation: the write API is a list of typed change operations, never
direct mutation. This keeps undo, preview, and safety consistent with the SCA
preview pattern that already exists.

## 5. Triggers

- Manual run is the only trigger in the first version. The user opens a
  script, runs it, sees the preview, and applies.
- Later possibilities: on-save hooks and computed columns. These run
  automatically and are riskier, because a bad script then runs without the
  user watching, and computed columns can fight the normal editing flow.

Recommendation: manual run first. Do not add automatic triggers until the
manual path is stable and trusted.

## 6. Storage

- Scripts live as plain files in the workspace, for example in a `scripts/`
  directory at the workspace root. Plain files are git-diffable and easy to
  back up with the rest of the workspace.
- A small manifest per script is not required in the first version; the file
  name and contents are enough.
- The script API is versioned. Each script declares which API version it
  targets, and the app refuses to run a script with an unknown version rather
  than guessing.

Recommendation: `scripts/*.rhn` (or whatever extension matches the language)
as plain workspace files, with a declared API version.

## 7. UI

- A script editor tab in the notes area, reusing the existing Markdown editor
  chrome but without Markdown rendering.
- An output console below or beside the editor that shows the script's stdout,
  returned values, and errors.
- Errors include the line number and a short message, with a link that jumps
  the cursor to that line.
- Buttons for Run, Preview, and Apply. Run executes and shows output; Preview
  shows the proposed changes; Apply writes them through undo.

Recommendation: reuse the editor tab and console patterns already in the app.
Do not build a separate window or panel system for scripts.

## 8. Risks

- Untrusted scripts in a shared workspace are the biggest risk. The sandbox
  and the proposed-change model are the mitigations.
- Data loss from a buggy apply. The undo integration and the preview are the
  mitigations, but a script that proposes a broad change can still do harm if
  the user applies without reading.
- API stability. Once scripts exist, the API becomes a promise. Versioning and
  a small, read heavy surface reduce this.
- Maintenance burden. A scripting language is a long term commitment. The
  smaller the language and the smaller the API, the cheaper this is.

Recommendation: ship the smallest API that covers lint checks and one bulk
transform, and treat every addition to the API as a versioned change.

## Questions to answer before code

1. Which language: Rhai, or Lua for familiarity?
2. Which use case ships first: lint checks, or one bulk transform?
3. Does the first version include notes in the read API, or words and tables
   only?
4. Are scripts per-workspace only, or is there a shared library of scripts?
5. What is the exact shape of the proposed-change list (rename, set field,
   create word, rewrite note), and which fields are settable?
6. How is the operations budget sized, and what number is the default?

## Suggested stage plan, smallest first

1. Language and sandbox proof: run a hardcoded script that returns a value,
   with the operations budget enforced.
2. Read only API over words and tables, and a script editor tab with Run and
   an output console.
3. Lint checks: a script returns a list of findings, shown as a report.
4. Proposed changes and the Preview and Apply flow through undo.
5. A word generation example script shipped with the app as documentation.
6. API versioning and the script directory layout.
