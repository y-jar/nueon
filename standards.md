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

## Docs

- `docs/PSD.md` is the living spec: any stage that changes behaviour updates its
  section (and proof) in the same commit.
- After adding or changing module headers, run `node scripts/gen-map.mjs` to
  refresh `docs/MAP.md`.
