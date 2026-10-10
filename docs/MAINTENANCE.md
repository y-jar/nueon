# Maintenance guide

How to keep the app healthy as a single maintainer. Read this when you come back
after a while, or before upgrading a dependency or releasing.

## The day-to-day contract

- Every change starts from a failing test/probe and ends green
  (`nix-shell --run loom-gates`, `nix build .#`, then the full probes). See
  `docs/PROBING.md`.
- `docs/PSD.md` is the living spec; when you change behaviour, update its section
  (and its proof column) in the same commit.
- Every `src/**` file has a one-line header; `scripts/check-headers.sh` fails if
  a new file lacks one. After adding/changing headers, run
  `nix-shell --run "node scripts/gen-map.mjs"` to refresh `docs/MAP.md`.

## Where to look first

- Want to find a component or module? `docs/MAP.md` is the generated index.
- Want to know what something *should* do? `docs/PSD.md`.
- Want to know the on-disk format? `docs/DATA-FORMATS.md`.
- Want to know an IPC command or the `data-changed` scopes? `docs/IPC.md`.
- Want to know how frontend state flows? `docs/STATE.md`.
- Want to know *why* a decision was made? `docs/DECISIONS.md`.

## Dependencies

- **Everything is pinned through `flake.nix`** (`frontend` is a `buildNpmPackage`;
  the Rust side is `buildRustPackage`). Upgrading a JS dependency: bump it in
  `package.json`, run `nix-shell --run npm install`, then update `npmDepsHash` in
  `flake.nix` to the hash nix reports (see the failing build log).
- **Rust deps** come from `Cargo.lock`; `nix build .#` uses it directly.
- **WebKitGTK / Tauri majors** are the risky ones: they can change event
  delivery, key values, scrollbars and `getComputedStyle` output. Re-run the full
  probe suite after such an upgrade; the quirks in `docs/DECISIONS.md` may move.

## Releases & versioning

- The version is a `YY.M.D` date (`26.10.6`); `scripts/bump-version.sh` sets it
  and `scripts/check-version.sh` validates it in gates. The `0.1.0` placeholder
  is valid only until the first real bump.
- The `.deb`/`.rpm`/AppImage are built by `npm run tauri build`; `nix build .#`
  builds the source variant. `flake.nix`'s `nueon-bin` package points at a
  GitHub release `.deb` with a placeholder hash until one is published (see
  `README.md`).

## When the app misbehaves

1. Read the status bar — `App.svelte` surfaces uncaught errors and unhandled
   rejections there now.
2. Reproduce it as a probe (`docs/PROBING.md`) before fixing, so it stays fixed.
3. If a UI thing can't be probed (native dialog, compositor geometry), use the
   manual injection probe in `docs/PROBING.md` §4, then restore the app.

## Keeping docs from rotting

The two things that stop docs going stale are mechanical, not willpower:

- `scripts/check-headers.sh` (in gates) forces every file to carry a header, so
  `docs/MAP.md` is always regenerable.
- `docs/PSD.md` ties each feature to its proof; when a probe changes or a feature
  shifts, the doc entry is wrong and you'll notice while editing.

Everything else in `docs/` is advisory; the gates only enforce headers and
versions.
