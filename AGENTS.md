# AGENTS.md

Guidance for agent sessions working in the nueon repo. Read this first; it is
short on purpose and links to the detail.

## Non-negotiable rules

- **Never touch the user's real data.** No opening/editing the real workspace
  or `~/.config/nueon`. Use temp dirs and copies. The probe harness
  (`probes/probe.mjs`) already isolates `HOME`/`XDG`/workspace for you.
- **Never push or create remotes.** Commit locally only, and only when asked.
- **Verify, don't assume.** Every stage starts with a failing test/probe that
  reproduces the problem, then makes it pass. Show both runs.
- **One commit per finished stage**, green before committing.
- **Don't add code comments** unless asked.
- **Keep the docs in sync.** Before changing behaviour, read `docs/PSD.md` (and
  the relevant `docs/` reference for the area). If a new feature or a change
  isn't documented, update it in the existing style, in the same commit:
  - `docs/PSD.md` — the feature's behaviour/data/invariants/code/proof entry.
  - `docs/IPC.md` — new or changed commands, and any `data-changed` scope.
  - `docs/STATE.md` / `docs/DATA-FORMATS.md` — state or on-disk format changes.
  - `docs/UI-CONVENTIONS.md` / `docs/DECISIONS.md` — new UI contracts or
    rationale.
  - Module headers — a new file gets a `//!`/`<!-- -->` one-liner, and
    `node scripts/gen-map.mjs` regenerates `docs/MAP.md`.

## Where things are

- `standards.md` — commit-message format and code rules.
- `docs/PROBING.md` — **how to test and probe here.** Read this before writing
  a test or "troubleshooting" a failure; it documents the three test tiers,
  the WebDriver probe harness, the manual fallback, and the traps that waste
  the most time (stale `result` after a failed `nix build`, flakes not seeing
  unstaged files, `pgrep`/`pkill` self-matches).
- `docs/ARCHITECTURE.md` — the three tiers: `nueon-core` (Rust) → Tauri IPC
  (`src-tauri/`) → Svelte 5 frontend (`src/`).
- `docs/PSD.md` — the **living spec**; update it when behaviour changes.
- `docs/MAP.md` — generated index of every module (from `scripts/gen-map.mjs`).
- `docs/IPC.md`, `docs/STATE.md`, `docs/DATA-FORMATS.md` — command surface,
  frontend state and on-disk formats.
- `docs/DECISIONS.md`, `docs/MAINTENANCE.md`, `docs/UI-CONVENTIONS.md` — why,
  how to maintain, and UI contracts.
- `docs/RELEASING.md` — the tag → CI → draft → publish release flow.
- `README.md` — features, install, verification commands.

## Gates (run before every commit)

`gates` (`loom-gates`) in the dev shell runs exactly this list, and
`.github/workflows/ci.yml` mirrors it — **keep all three in sync**. Run inside
`nix-shell` (cargo/node are not on the host `PATH`). After packaging changes,
also `nix build .#`.

```sh
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run check
npm run test
sh scripts/check-icons.sh
sh scripts/check-headers.sh
sh scripts/test-version.sh
sh scripts/check-version.sh
```

CI adds `npm ci` first; it never runs the WebDriver probes or `nix build`.

## Before you debug a failing check

Three things cause most of the wasted time — check them first:

1. **Did the `nix build` actually succeed?** A failed build leaves `result`/`-o`
   at the previous success, so you verify old code. Read the log for
   `error`/`Could not resolve` and confirm the output timestamp changed.
2. **Did you `git add` new files?** Nix flakes only see tracked/staged files.
3. **Read the real error** before changing anything. The probe/test already
   printed it; look, don't guess, and don't rebuild blindly.

Full details, templates, and a debugging decision tree: `docs/PROBING.md`.
