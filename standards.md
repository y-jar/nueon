# Standards

## Commit messages

Every completed stage is committed with this subject format:

```
<subject>: <feature> + <feature> [+ <feature> ...]
```

- **subject** — the area in one word, lowercase (e.g. `tabs`, `links`, `ui`,
  `docs`, `workspace`, `grid`, `phonology`, `morphology`).
- **feature** — a short lowercase description of what changed. Join multiple with
  ` + `.
- One commit per finished stage; commit before starting the next stage.
- Never use conventional-commit prefixes (`feat:`, `fix:`, `chore:`), emojis, or
  AI-attribution footers.

An optional body may list details as bullets.

Examples:

```
tabs: hide horizontal scrollbar
links: readable dropdown selection
docs: module headers + generated source map
```

## Code

- `cargo fmt` and `cargo clippy --all-targets -- -D warnings` must pass.
- All storage writes are atomic; workspace paths are never escaped.
- Git integration goes through the system `git` CLI, never a linked library.
- Every `src/**` source file carries a one-line module header (`//!` for TS,
  `<!-- -->` for Svelte); `scripts/check-headers.sh` enforces this.
- Don't add code comments unless asked.
- Avoid `{@const}` over a nullable value inside a conditionally-destroyed block —
  use a script-level `$derived` instead (it once left a menu stuck on screen).

## UI performance and errors

- **No probe may pass with an error in the status bar.** Every probe records
  window errors, unhandled rejections and the status-bar error text, and fails
  if any appears. A probe that triggers an error on purpose says so with
  `allowErrors`; nothing else is allow-listed.
- **Every editor view needs an idle-cost probe** (nobody touching the page for
  3 s: no frame gap or late timer over 50 ms) and a pointer-latency probe.
- **An `$effect` must not write state it reads.** Compute values with
  `$derived`. When an effect must call a setter (a ResizeObserver callback, a
  store function), wrap the call in `untrack`, and make the setter compare
  before it assigns, so an equal value is never written. A new object or array
  counts as a change even when its contents are equal.
- **An async continuation must not write state after its owner unmounts.** Any
  `await` inside an effect, its callees, or an event handler whose writes are
  picked up by reactive rendering must be guarded: an `alive` flag set false in
  the effect's cleanup, and a generation counter that a newer load invalidates
  (see `DerivationGraph`'s `reload`). Without the guard, the write schedules an
  update on a destroyed subtree and reads a just-destroyed branch's props, which
  is how `88` used to throw.
- **A generation token compared against deep `$state` must be read back from the
  state, not the raw object.** Assigning into a deep `$state` proxy wraps the
  object, so `editor.outline === rawObject` is always false and the guard
  silently rejects every load (the back image drew only after the probe proved
  the sync had never completed). Capture the stored value after the assignment —
  `const stored = editor.outline` — and compare against that, as
  `refreshLibrary` already does.
  is how `88` used to throw.

## Docs

- `docs/PSD.md` is the living spec: any stage that changes behaviour updates its
  section (and proof) in the same commit.
- After adding or changing module headers, run `node scripts/gen-map.mjs` to
  refresh `docs/MAP.md`.
