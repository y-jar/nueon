# Probing & testing guide

This is the working manual for verifying changes in nueon — for humans and for
other agent sessions. Read it before writing a test or "troubleshooting" a
failing check. Almost every wasted-token rabbit hole in this repo has come from
re-deriving one of the recipes below or from trusting a stale build.

The single most important rule: **verify against observable state, and make the
build you are testing prove it succeeded.** Everything else follows.

---

## 1. Pick the right tier

| Tier | Tool | Use for | Run |
| --- | --- | --- | --- |
| Pure logic | `node:test` | Functions with no Svelte/Tauri/DOM: value formatting, cursor math, tab-group rules | `npm run test` |
| Core behavior | `cargo test` | Everything in `nueon-core`: model, storage, import/export, vcs | `cargo test --workspace` |
| Real UI | Packaged probe (WebDriver) | Anything that needs the app running: editor, grid, tabs, splits, wizard | `npm run probe` |
| Real UI, odd cases | Manual injection probe | Native file dialogs, multi-window, compositor geometry, anything WebDriver can't reach | see §4 |

Reach for the cheapest tier that can actually observe the behavior. A cursor
calculation does **not** need the app running; a "closing a tab removes the
split pane" bug **does**.

### Pure unit tests (`node:test`)

Files live beside the code as `src/lib/**/*.test.ts` (e.g.
`src/lib/gridView.test.ts`, `src/lib/tabs.test.ts`,
`src/lib/editor/diff.test.ts`). They run on Node 22's built-in runner with type
stripping — **no test framework, no new dependencies**:

```sh
npm run test
# = node --test --experimental-strip-types "src/lib/**/*.test.ts"
```

Rules:

- Relative imports must include the extension (`import { x } from "./tabs.ts"`)
  or Node cannot resolve them at runtime. `tsconfig.json` sets
  `allowImportingTsExtensions` and `exclude: ["src/**/*.test.ts"]`, so
  `svelte-check` never sees these files (they use `node:` built-ins it lacks
  types for).
- Extract the decision under test into a **pure** function (see
  `src/lib/tabs.ts` → `shouldPruneGroup`) rather than trying to instantiate the
  runes store. The store needs the DOM and Tauri IPC; a pure helper does not.

### Rust tests

- Unit tests live inline (`#[cfg(test)] mod tests`).
- Integration tests live in `crates/nueon-core/tests/*.rs` and read the
  committed fixtures under `crates/nueon-core/tests/fixtures/`, located via
  `env!("CARGO_MANIFEST_DIR")` — never a hard-coded absolute path.
- **Compute expected values from the fixtures, don't hard-code them.** Read the
  file in the test and derive the count, so the test keeps meaning if the data
  changes.

---

## 2. Packaged probes — the WebDriver harness (primary)

`probes/probe.mjs` drives a **real built binary** over WebDriver
(`tauri-driver` + `WebKitWebDriver`) inside a throwaway `Xvfb` display, against
a throwaway `HOME`/`XDG`/workspace at `/tmp/opencode/nueon-probe`. It never
touches the user's real config or workspace. Screenshots land in `probes/out/`.

### Prerequisites

Run **inside `nix-shell`**: the dev shell puts `Xvfb` (from xorg-server) and
`WebKitWebDriver` (from webkitgtk) on `PATH`. `tauri-driver` is installed
on demand to `/tmp/opencode/tauri-driver-root` the first time (needs network).

### Running it

```sh
nix build .# -o /tmp/probe-bin        # build the packaged binary first
npm run probe                         # defaults to target/debug/nueon
node probes/probe.mjs /tmp/probe-bin/bin/nueon   # explicit binary
```

It prints `PASS <name>` / `FAIL <name>: <why>` per probe, a `N/N probes passed`
summary, writes screenshots to `probes/out/`, and **exits non-zero on any
failure**. No app instrumentation is required — probes reach into the running
webview through WebDriver's `execute/sync`.

### The helper API (`probes/probe.mjs`)

Everything runs inside the webview unless noted:

- `js(scriptExpr)` — run JS, return the value. A bare expression is wrapped in
  `return (...)` for you.
- `waitJs(expr, { timeout, every, label })` — poll until truthy; **prefer this
  over fixed `setTimeout` sleeps**. Throws with the last value on timeout.
- `click(selector)` — DOM `.click()` (not a real pointer press; WebKit's
  interactability check is unreliable under fontless Xvfb).
- `find(selector)`, `doubleClick(selector)`, `typeInto(selector, text)` —
  WebDriver element actions for when a real focus/value path matters.
- `screenshot(name)` — base64 screenshot → `probes/out/<name>.png`.
- `openNote(path)`, `placeCursor(path, offset)`, `readEditorState(path)`
  (`{ anchor, head, top, length }`), `editorText(path)` — editor helpers.
- `triggerReload()` — emits a backend `data-changed {scope:"notes"}` by creating
  a folder, i.e. exactly how a git checkout notifies the editor, without
  touching the open note.
- `probe(name, fn)` + `assertEqual(actual, expected, what)` — wrap each check;
  a throw is recorded as a failure without aborting the rest.

`viewScript(path)` locates the live `EditorView` via
`content.cmTile.root.view` (the same path CodeMirror's own
`EditorView.findFromDOM` uses), so probes work on any build.

### Adding a probe — template

Append to `main()` in `probes/probe.mjs`, following the sequence: **create
state → drive the DOM → `waitJs` for the effect → assert → screenshot.**

```js
// -- probe N: <one line of intent> ---------------------------------------
await openNote("alpha.md");
await placeCursor("alpha.md", 120);
const before = await readEditorState("alpha.md");

await click(".tab-label");            // or find()/doubleClick()/typeInto()
await waitJs(
  `document.querySelector('.cm-host[data-note="alpha.md"]') !== null`,
  { label: "alpha editor mounted" },
);

const after = await readEditorState("alpha.md");
await screenshot("pN-what-changed");
await probe("N-what-should-hold", async () => {
  assertEqual(after.name, before.name, "whatever you changed");
});
```

`assertEqual` is reference equality (`!==`) — compare scalars; for objects,
compare a derived field (e.g. `after.anchor`).

### When the harness can't help

It drives a single webview via DOM/WebDriver. It **cannot**: interact with a
native file dialog, synthesise a real OS-level drag between two windows, or
read the compositor's window geometry. Those need §4.

---

## 3. Keep the harness honest

- **One focused probe per behavior.** A failing probe name should point at one
  assertion.
- **Assert on state you can name**: a store value read back through the DOM, a
  file's contents on disk, a visible element. Not "it looks right".
- **Don't poll with `sleep`.** Use `waitJs`; it fails fast with the last value.
- **Read the actual failure** before changing anything. The probe already
  printed the message and took a screenshot — look at them.
- **Seeded environment**: `seedWorkspace()` writes a fixed set of notes
  (`alpha.md` with 120 lines, `beta.md` and several editor/fixture notes) into
  the throwaway workspace and registers it in the throwaway config, so the app
  boots straight into the shell.

---

## 4. Manual injection probes (fallback)

Use this only when the WebDriver harness can't observe the behavior (native
dialogs, multi-window tear-off, compositor geometry, OS file drops). It is more
fragile; treat it as a last resort and **restore the app afterward.**

Recipe:

1. **Isolate the environment.** Create a throwaway config dir whose
   `config.toml` points `last` at a throwaway copy of a workspace:

   ```sh
   rm -rf /tmp/ws-x /tmp/cfg-x && cp -a /path/to/workspace /tmp/ws-x
   mkdir -p /tmp/cfg-x/nueon
   printf 'last = "/tmp/ws-x"\n\n[[workspaces]]\nname = "ws-x"\npath = "/tmp/ws-x"\n' \
     > /tmp/cfg-x/nueon/config.toml
   ```

   Launch with `XDG_CONFIG_HOME=/tmp/cfg-x` so the **user's real registry is
   never opened.**

2. **Inject a temporary probe into `src/App.svelte`** inside `onMount`, after
   `installFileDrop()`. Collect `PASS`/`FAIL` strings and write them out as a
   note so you can read them from disk:

   ```js
   setTimeout(async () => {
     const out = [];
     const check = (n, got, want) =>
       out.push((JSON.stringify(got) === JSON.stringify(want) ? "PASS " : "FAIL ") + n);
     try {
       await openTable("t");                 // import the state fns you need
       // ...drive state / DOM...
       check("thing", ui.groups.length, 1);
     } catch (e) { out.push("ERR " + String(e)); }
     try { await api.createNoteWithContent("probe-result", out.join("\n")); }
     catch (e) { ui.status = "WL " + String(e); }
   }, 2500);
   ```

   `createNoteWithContent` refuses to overwrite, so use a **fresh workspace**
   each run (or a unique note name) — otherwise the write fails with
   `already exists` and you get no output.

3. **Build and stage.** `git add -A src` (the flake only sees staged/tracked
   files — see §5), then `nix build .# -o /tmp/probe-x`. Keep the injected
   `App.svelte` in place until the build finishes, then **restore it**:
   `git checkout HEAD -- src/App.svelte`.

4. **Run and read.** Launch the built binary with the isolated
   `XDG_CONFIG_HOME`, wait for `notes/probe-result.md` to appear, and `cat` it.

5. **Screenshots (compositor path).** The real desktop is the `mango`
   compositor. Get geometry then capture:

   ```sh
   timeout 6 mmsg get all-clients | python3 -c \
     'import json,sys; d=json.load(sys.stdin); \
      [print(c["x"],c["y"],c["width"],c["height"]) for c in d if c.get("appid")=="nueon"]'
   grim -g "<x>,<y> <w>x<h>" /tmp/shot.png
   ```

   - Screenshots are indexed with a lag; if a just-written PNG isn't readable
     yet, re-`cp` it to a fresh name and read again.
   - Window position is chosen by the compositor — always read geometry, don't
     assume `10,10`.
   - `grim` needs the window's global coordinates; multi-monitor origins can be
     large (e.g. `x≈3522`).

---

## 5. Critical gotchas (read before you debug)

### Nix flakes only see tracked/staged files

`nix build .#` evaluates the **git tree**, not the working directory. A new
untracked file (a new component, `GroupBody.svelte`, a probe edit, a fixture) is
**invisible** until `git add`. Symptom: the build "succeeds" but the app behaves
as if your change isn't there.

> Before every verification build: `git add -A` (or the specific new files).

### A failed build leaves `result` at the last success

If `nix build` fails (e.g. a JS parse error), the `result`/`-o` symlink keeps
pointing at the **previous successful build**. The app then runs old code, and
you'll "verify" the wrong thing. Always confirm the build actually succeeded
before launching:

```sh
nix build .# -o /tmp/probe-x > /tmp/nixbuild.log 2>&1
echo "exit=$?"
grep -E "error|Could not resolve|RollupError" /tmp/nixbuild.log && echo BUILD-FAILED
```

Also check the output path's timestamp changed (`stat -c '%y' /tmp/probe-x`).

### Process-management traps

- `pgrep -f 'nix build'` / `pkill -f 'pattern'` **match the polling shell
  command itself** and can hang the loop or kill your own shell. Poll a
  **unique output path** instead, or match a distinctive string, or use
  `pkill -x nueon`:
  - Good: `until [ -e /tmp/probe-x ]; do sleep 5; done` (or check the symlink
    timestamp), `pkill -x nueon`, `pkill -f '[a]pp-wrapper.sh'`.
- Don't background a long build **and** foreground-wait in the same shell call;
  it can trip the command timeout and abort mid-run. Start detached
  (`setsid … &`) and poll in a separate call.

### Environment

- `nix-shell --run '<cmd>'` wraps every tool; `cargo`/`node` are not on the
  host `PATH`.
- The dev shell's `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE`
  are needed on Wayland but **blank the webview's surface under Xvfb** — the
  WebDriver harness unsets them for that reason (`writeWrapper`).
- There is **no input-synthesis tool** (`ydotool`/`wtype`/`xdotool` absent).
  To test a click/drag, dispatch a synthetic DOM event in `js()`, or use the
  WebDriver pointer actions.

---

## 6. Debugging decision tree

- **"The probe never ran / no result file."** Check, in order: did the build
  actually succeed (§5)? were the new files `git add`ed (§5)? did the guard
  condition fire (e.g. `layoutReady`, a table present)? did the result note
  already exist so `createNoteWithContent` refused? Screenshot the status bar
  (`ui.status`) — an uncaught error or a `WL already exists` shows there.
- **"The app window is blank."** Almost always a JS error at module load:
  a duplicate import name (e.g. `closeTab` imported twice) is a hard parse
  error; an unhandled promise rejection blanks the shell; or the Wayland
  `WEBKIT_DISABLE_*` flags were set under Xvfb. Add a
  `window.addEventListener("error"|"unhandledrejection", …)` that writes to
  `ui.status`, then screenshot the status bar.
- **"Assertion failed."** Read the actual `got`/`want` and the screenshot.
  Instrument the real state (dump `ui.*` / DOM text into the result note)
  instead of guessing and rebuilding repeatedly.
- **"It works on a fresh workspace but not mine."** You are probably reading
  the real config/workspace. Confirm `XDG_CONFIG_HOME` points at the throwaway
  dir, and that the throwaway workspace is a *copy*.

---

## 7. Cost anti-patterns (the ones that burn the most tokens)

1. **Re-running a build without reading its log.** One `grep error` beats five
   rebuilds.
2. **Trusting a screenshot from a stale `result`.** Confirm the build first.
3. **Forgetting to `git add` new files** and concluding "the fix doesn't work".
4. **Editing `App.svelte` for a probe and never restoring it.** Restore with
   `git checkout HEAD -- src/App.svelte` and re-`git add`.
5. **Re-deriving the probe harness.** It already exists (`probes/probe.mjs`);
   extend it.
6. **Hard-coding fixture counts.** Compute them from the file.
7. **Running the whole suite** to check one behavior when a single probe or
   `node --test <file>` would do.
8. **`pkill -f` self-matches.** Prefer `pkill -x nueon` / bracketed patterns.

---

## 8. Gates & the failing-first contract

Every stage must: start with a **failing** test/probe that reproduces the
problem, then make it pass, and leave the gates green:

```sh
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run check
npm run test
sh scripts/check-icons.sh
sh scripts/test-version.sh
sh scripts/check-version.sh
# after packaging changes / final verification:
nix build .#
```

`gates` in the dev shell runs exactly the nine checks above except `nix build`
(and CI mirrors it after `npm ci`). Rules:

- **Never touch the user's real workspace or `~/.config/nueon`.** Use temp dirs
  and copies; the WebDriver harness already does this for you.
- **Show the failing run and the passing run.** A test that was never observed
  failing proves less.
- **One commit per finished stage**, verified green before committing.
