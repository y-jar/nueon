#!/usr/bin/env node
/**
 * Packaged-build probes for the notes editor.
 *
 * Drives a real, built nueon binary over WebDriver (tauri-driver +
 * WebKitWebDriver) inside a throwaway Xvfb display, against a throwaway
 * HOME/XDG and a throwaway workspace — the user's real config and workspace
 * are never touched.
 *
 *   node probes/probe.mjs [path-to-binary]
 *
 * Expects: Xvfb and WebKitWebDriver on PATH (the nix dev shell provides
 * both), and tauri-driver (installed on demand to /tmp if missing).
 * Screenshots land in probes/out/.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = path.resolve(process.argv[2] ?? "target/debug/nueon");
const ROOT = "/tmp/opencode/nueon-probe";
const OUT = path.resolve(import.meta.dirname, "out");
const PORT = 4444;
const DISPLAY = `:${99 + (process.pid % 40)}`;
const WORKSPACE = path.join(ROOT, "ws", "probe");

const DRIVER_CANDIDATES = [
  "/tmp/opencode/tauri-driver-root/bin/tauri-driver",
  "tauri-driver",
];

// -- tiny WebDriver client ------------------------------------------------

let sessionId = null;

async function wd(method, endpoint, body) {
  const base = `http://127.0.0.1:${PORT}`;
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`webdriver ${method} ${endpoint}: ${response.status} ${text.slice(0, 200)}`);
  }
  if (!response.ok && parsed?.value?.error !== "no such element") {
    throw new Error(`webdriver ${method} ${endpoint}: ${JSON.stringify(parsed.value).slice(0, 300)}`);
  }
  return parsed.value;
}

/** Run synchronous JS inside the webview and return the result. */
function js(script, ...args) {
  return wd("POST", `/session/${sessionId}/execute/sync`, { script, args });
}

/** Poll `script` until it returns truthy; returns the value or throws. */
async function waitJs(script, { timeout = 20000, every = 200, label = "" } = {}) {
  // Bare expressions are wrapped so callers don't repeat `return`.
  const body = script.trimStart().startsWith("return")
    ? script
    : `return (${script});`;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await js(body);
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  throw new Error(`waitJs timed out (${label || script.slice(0, 80)}) last=${JSON.stringify(last)?.slice(0, 200)}`);
}

async function find(selector) {
  const value = await wd("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector,
  });
  return value?.["element-6066-11e4-a52e-4f735466cecf"];
}

/**
 * Click via the DOM: WebKitWebDriver's interactability check is unreliable
 * under Xvfb (fontless layouts), and the probes assert editor state, not
 * pixel hit-testing.
 */
async function click(selector) {
  const found = await js(
    `const el = document.querySelector(${JSON.stringify(selector)});
     if (!el) return false;
     el.click();
     return true;`,
  );
  if (!found) throw new Error(`no element: ${selector}`);
}

/** Synthetic events for the rename input: deterministic and focus-free. */
function renameViaInput(notePath, newName) {
  return js(
    `const input = document.querySelector('.tree-row[data-path="${notePath}"] input.new-input');
     if (!input) return false;
     input.value = ${JSON.stringify(newName)};
     input.dispatchEvent(new Event("input", { bubbles: true }));
     input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
     return true;`,
  );
}

async function doubleClick(selector) {
  const id = await find(selector);
  if (!id) throw new Error(`no element: ${selector}`);
  const element = { "element-6066-11e4-a52e-4f735466cecf": id };
  await wd("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: element, x: 2, y: 2 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
          { type: "pointerDown", button: 0 },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

async function typeInto(selector, text) {
  const id = await find(selector);
  if (!id) throw new Error(`no element: ${selector}`);
  await wd("POST", `/session/${sessionId}/element/${id}/click`);
  await wd("POST", `/session/${sessionId}/element/${id}/value`, { text });
}

// WebDriver key values: Tab, Enter, Control.
const TAB = "\uE004";
const ENTER = "\uE007";
const CTRL = "\uE009";

/** Press a key, optionally held with modifiers (e.g. `pressKey("z", [CTRL])`). */
async function pressKey(value, modifiers = []) {
  const actions = [];
  for (const modifier of modifiers) actions.push({ type: "keyDown", value: modifier });
  actions.push({ type: "keyDown", value });
  actions.push({ type: "keyUp", value });
  for (const modifier of [...modifiers].reverse()) {
    actions.push({ type: "keyUp", value: modifier });
  }
  await wd("POST", `/session/${sessionId}/actions`, {
    actions: [{ type: "key", id: "keys", actions }],
  });
}

/** Focus the editor for `notePath` with a real WebDriver element click. */
async function focusEditor(notePath) {
  const id = await find(`.cm-host[data-note="${notePath}"] .cm-content`);
  if (!id) throw new Error(`no editor content for ${notePath}`);
  await wd("POST", `/session/${sessionId}/element/${id}/click`);
}

async function screenshot(name) {
  try {
    const png = await wd("GET", `/session/${sessionId}/screenshot`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, "base64"));
  } catch (error) {
    console.log(`  (screenshot ${name} failed: ${error})`);
  }
}

// -- editor state helpers (run inside the webview) -------------------------

/**
 * The live EditorView for a note, found the same way CodeMirror's own
 * `EditorView.findFromDOM` does (DOM element → cmTile → root → view), so the
 * probes need no instrumentation in the app and work on any build.
 */
function viewScript(notePath) {
  return `const host = document.querySelector('.cm-host[data-note=${JSON.stringify(notePath)}]');
    const content = host?.querySelector('.cm-content');
    const v = content?.cmTile?.root?.view ?? host?.cmTile?.root?.view ?? null;
    if (!v) return null;
    const scroller = host.querySelector('.cm-scroller');`;
}

/** Selection + first-visible-line of the editor for `notePath`. */
async function readEditorState(notePath) {
  const result = await js(
    `${viewScript(notePath)}
     try {
       return {
         anchor: v.state.selection.main.anchor,
         head: v.state.selection.main.head,
         top: v.lineBlockAtHeight(scroller.scrollTop + v.documentTop).from,
         length: v.state.doc.length,
       };
     } catch (error) {
       return { err: (error.stack || String(error)).slice(0, 500) };
     }`,
  );
  if (result?.err) throw new Error(`readEditorState(${notePath}): ${result.err}`);
  return result;
}

/** Place the cursor and make that line the first visible one. */
async function placeCursor(notePath, offset) {
  const result = await js(
    `${viewScript(notePath)}
     try {
       v.dispatch({ selection: { anchor: ${offset} } });
       scroller.scrollTop = v.lineBlockAt(${offset}).top;
       return true;
     } catch (error) {
       return "ERR " + (error.stack || String(error)).slice(0, 400);
     }`,
  );
  if (typeof result === "string" && result.startsWith("ERR")) {
    throw new Error(`placeCursor(${notePath}, ${offset}): ${result}`);
  }
  // Let CodeMirror finish the scroll-triggered measure before reading.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

function editorText(notePath) {
  return js(
    `${viewScript(notePath)}
     return v.state.doc.toString();`,
  );
}

/** Poll until the editor's document equals `expected` (or throw). */
async function waitEditorText(notePath, expected, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await editorText(notePath);
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `editor ${notePath} mismatch: ${JSON.stringify(last)?.slice(0, 120)}`,
  );
}

// -- environment ------------------------------------------------------------

const children = [];

function spawnLogged(name, command, args, env = {}) {
  // Detached: tauri-driver spawns WebKitWebDriver and the app itself, so the
  // whole tree is killed via the process group.
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) console.log(`  [${name}] ${line.slice(0, 160)}`);
  });
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }
  }
  // Sweep strays from crashed runs: our app wrapper marks its environment.
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      if (environ.includes("nueon-probe")) process.kill(Number(pid), "SIGKILL");
    } catch { /* not ours / gone */ }
  }
}

function ensureTauriDriver() {
  for (const candidate of DRIVER_CANDIDATES) {
    const found =
      candidate.includes("/") && fs.existsSync(candidate)
        ? candidate
        : spawnSync("which", [candidate]).stdout.toString().trim();
    if (found) return found;
  }
  console.log("tauri-driver missing; installing to /tmp (one-off)…");
  const result = spawnSync(
    "cargo",
    ["install", "tauri-driver", "--locked", "--root", "/tmp/opencode/tauri-driver-root"],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("could not install tauri-driver");
  return DRIVER_CANDIDATES[0];
}

/** A throwaway workspace + registry so the app boots straight into it. */
function seedWorkspace() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORKSPACE, "notes"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: WORKSPACE });
  const lines = Array.from(
    { length: 120 },
    (_, i) => `line ${String(i + 1).padStart(3, "0")}`,
  );
  fs.writeFileSync(path.join(WORKSPACE, "notes", "alpha.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "beta.md"), "beta note\n");
  const configDir = path.join(ROOT, "home", ".config", "nueon");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.toml"),
    `last = "${WORKSPACE}"\n\n[[workspaces]]\npath = "${WORKSPACE}"\nname = "probe"\n`,
  );
}

/** Wrap the binary so the app runs with the throwaway HOME/XDG. */
function writeWrapper() {
  const wrapper = path.join(ROOT, "app-wrapper.sh");
  // The dev shell's WEBKIT_DISABLE_* workarounds are for Wayland; under Xvfb
  // they blank the webview's screenshot surface, so the app runs without them.
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
unset WEBKIT_DISABLE_DMABUF_RENDERER
unset WEBKIT_DISABLE_COMPOSITING_MODE
export HOME="${path.join(ROOT, "home")}"
export XDG_CONFIG_HOME="${path.join(ROOT, "home", ".config")}"
export XDG_DATA_HOME="${path.join(ROOT, "home", ".local", "share")}"
export XDG_CACHE_HOME="${path.join(ROOT, "home", ".cache")}"
exec "${APP}" "$@"
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

// -- probes -----------------------------------------------------------------

const results = [];

async function probe(name, fn) {
  try {
    await fn();
    results.push([name, "PASS", ""]);
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push([name, "FAIL", String(error?.message ?? error)]);
    console.log(`FAIL ${name}: ${String(error?.message ?? error).slice(0, 300)}`);
  }
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

async function openNote(notePath) {
  await click(`.tree-row[data-path="${notePath}"] .tree-name`);
  await waitJs(
    `!!document.querySelector('.cm-host[data-note=${JSON.stringify(notePath)}] .cm-content')`,
    { label: `editor for ${notePath}` },
  );
}

/**
 * Nudge the app into a `reloadOpenNotes` pass without touching the open
 * note: creating a folder emits `data-changed` (scope "notes") from the
 * backend, which is exactly how a git checkout notifies the editor.
 */
async function triggerReload() {
  const name = `zz-reload-${Math.random().toString(36).slice(2, 8)}`;
  await click(".explorer-actions button:nth-of-type(2)");
  await waitJs(`!!document.querySelector('.sidebar input.new-input')`, {
    label: "new-folder input",
  });
  await js(
    `const input = document.querySelector('.sidebar input.new-input');
     input.value = ${JSON.stringify(name)};
     input.dispatchEvent(new Event("input", { bubbles: true }));
     input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
     return true;`,
  );
  await waitJs(
    `!!document.querySelector('.tree-row[data-path="${name}"]')`,
    { label: "folder in tree" },
  );
}

const alphaFile = () => path.join(WORKSPACE, "notes", "alpha.md");

async function main() {
  if (!fs.existsSync(APP)) {
    throw new Error(`app binary not found: ${APP} (build it first)`);
  }
  cleanup(); // sweep strays from a crashed previous run
  seedWorkspace();
  const wrapper = writeWrapper();
  const driver = ensureTauriDriver();

  spawnLogged("xvfb", "Xvfb", [DISPLAY, "-screen", "0", "1400x900x24"]);
  const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
  for (let i = 0; i < 50 && !fs.existsSync(socket); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(socket)) throw new Error("Xvfb did not start");

  spawnLogged("driver", driver, ["--port", String(PORT)], { DISPLAY });
  for (let i = 0; i < 50; i += 1) {
    const up = await fetch(`http://127.0.0.1:${PORT}/status`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const capabilities = {
    capabilities: {
      alwaysMatch: { "tauri:options": { application: wrapper } },
    },
  };
  const session = await wd("POST", "/session", capabilities);
  sessionId = session?.sessionId;
  if (!sessionId) throw new Error("no webdriver session id");

  await new Promise((resolve) => setTimeout(resolve, 6000));
  await screenshot("boot");
  console.log(
    "boot state:",
    JSON.stringify(
      await js(`return {
        onboarding: !!document.querySelector(".onboarding"),
        sidebar: !!document.querySelector(".sidebar"),
        error: document.querySelector(".onboarding .error")?.textContent ?? null,
        text: document.body?.innerText?.slice(0, 200) ?? "",
      };`),
    ),
  );

  // The workspace is pre-registered: the app boots straight into the shell.
  await waitJs(`!!document.querySelector(".sidebar")`, {
    timeout: 40000,
    label: "app shell",
  });
  await waitJs(`!!document.querySelector('.tree-row[data-path="alpha.md"]')`, {
    label: "seeded notes in tree",
  });

  // -- probe 1: tab switch restores cursor + top line ----------------------
  await openNote("alpha.md");
  await waitJs(
    `(document.querySelector('.cm-host[data-note="alpha.md"] .cm-content')?.cmTile?.root?.view?.state.doc.length ?? 0) > 900`,
    { label: "alpha content loaded" },
  );
  await openNote("beta.md"); // open the second tab once, so both tabs exist
  await openNote("alpha.md");
  await placeCursor("alpha.md", 320); // start of line 41
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the scroll settle
  const before = await readEditorState("alpha.md");
  await openNote("beta.md");
  await openNote("alpha.md");
  await new Promise((resolve) => setTimeout(resolve, 500)); // remount + restore
  const after = await readEditorState("alpha.md");
  await screenshot("p1-tab-switch");
  await probe("1-tab-switch-restores-cursor-and-scroll", async () => {
    assertEqual(after?.anchor, before?.anchor, "cursor after tab switch");
    assertEqual(after?.top, before?.top, "top line after tab switch");
  });

  // -- probe 2: external edit below the cursor leaves it still -------------
  await placeCursor("alpha.md", 160); // line 21
  const baseline2 = await readEditorState("alpha.md");
  fs.appendFileSync(alphaFile(), "external-below\n");
  await triggerReload();
  await waitJs(
    `(document.querySelector('.cm-host[data-note="alpha.md"] .cm-content')?.cmTile?.root?.view?.state.doc.toString() ?? "").includes("external-below")`,
    { timeout: 10000, every: 150, label: "external edit noticed" },
  );
  const afterBelow = await readEditorState("alpha.md");
  await probe("2-external-edit-below-keeps-cursor", async () => {
    assertEqual(afterBelow?.anchor, baseline2?.anchor, "cursor after edit below");
  });

  // -- probe 3: external edit above the cursor shifts it -------------------
  const marker = "external-above\n";
  fs.writeFileSync(alphaFile(), marker + fs.readFileSync(alphaFile(), "utf8"));
  await triggerReload();
  await waitJs(
    `(document.querySelector('.cm-host[data-note="alpha.md"] .cm-content')?.cmTile?.root?.view?.state.doc.toString() ?? "").startsWith("external-above")`,
    { timeout: 10000, every: 150, label: "external edit above noticed" },
  );
  const afterAbove = await readEditorState("alpha.md");
  await probe("3-external-edit-above-shifts-cursor", async () => {
    assertEqual(
      afterAbove?.anchor,
      (baseline2?.anchor ?? 0) + marker.length,
      "cursor after edit above",
    );
  });

  // -- probe 4 (guard): a save landing between a read and its resolve ------
  // The deterministic race is unit-tested (freshness.test.ts); here we guard
  // the wiring: type, immediately trigger a reload pass (its read races the
  // debounced autosave), and the typed text + cursor must survive.
  await js(
    `${viewScript("alpha.md")}
     const at = v.state.selection.main.anchor;
     v.dispatch({ changes: { from: at, insert: "marker-p4 " } });
     return true;`,
  );
  const typedAnchor = (await readEditorState("alpha.md"))?.anchor;
  await triggerReload();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (fs.readFileSync(alphaFile(), "utf8").includes("marker-p4")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const afterSave = await readEditorState("alpha.md");
  const text4 = await editorText("alpha.md");
  await probe("4-save-then-reload-keeps-buffer-and-cursor", async () => {
    if (!text4?.includes("marker-p4")) throw new Error("typed text vanished");
    assertEqual(afterSave?.anchor, typedAnchor, "cursor after save+reload");
  });

  // -- probe 5: rename keeps the position under the new path ---------------
  await placeCursor("alpha.md", 240); // line 31
  const before5 = await readEditorState("alpha.md");
  await js(
    `document.querySelector('.tree-row[data-path="alpha.md"] .tree-name')
       .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
     return true;`,
  );
  await waitJs(`!!document.querySelector('.tree-row[data-path="alpha.md"] input.new-input')`, {
    label: "rename input",
  });
  await renameViaInput("alpha.md", "gamma");
  await waitJs(`!!document.querySelector('.tree-row[data-path="gamma.md"]')`, {
    label: "renamed tree row",
  });
  await waitJs(
    `!!document.querySelector('.cm-host[data-note="gamma.md"] .cm-content')`,
    { label: "editor for renamed note" },
  );
  await new Promise((resolve) => setTimeout(resolve, 500)); // restore settles
  const after5 = await readEditorState("gamma.md");
  await screenshot("p5-rename");
  await probe("5-rename-keeps-position-under-new-path", async () => {
    assertEqual(after5?.anchor, before5?.anchor, "cursor after rename");
  });

  // -- probe 6: undo cannot revert an external reload ----------------------
  // A git checkout / external write follows the file. If the reload enters
  // the undo history, Ctrl+Z replays the old text and autosaves it back over
  // the new file — the buffer must stay on the disk content.
  await openNote("gamma.md");
  const reloaded = "reload one\nreload two\nreload three\n";
  fs.writeFileSync(path.join(WORKSPACE, "notes", "gamma.md"), reloaded);
  await triggerReload();
  await waitEditorText("gamma.md", reloaded);
  await focusEditor("gamma.md");
  await pressKey("z", [CTRL]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterUndo6 = await editorText("gamma.md");
  await screenshot("p6-undo-after-reload");
  await probe("6-undo-cannot-revert-external-reload", async () => {
    assertEqual(afterUndo6, reloaded, "buffer after undo");
  });
}

try {
  await main();
} catch (error) {
  console.log(`HARNESS-ERROR ${String(error?.stack ?? error).slice(0, 500)}`);
  results.push(["harness", "FAIL", String(error)]);
} finally {
  if (sessionId) {
    await wd("DELETE", `/session/${sessionId}`).catch(() => {});
  }
  cleanup();
}

const failed = results.filter(([, status]) => status !== "PASS");
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  for (const [name, , why] of failed) console.log(`  FAIL ${name}: ${why.slice(0, 160)}`);
}
process.exit(failed.length ? 1 : 0);
