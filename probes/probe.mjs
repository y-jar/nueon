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
// Headless Xvfb by default; `PROBE_DISPLAY=:0` drives a display you can watch.
const DISPLAY = process.env.PROBE_DISPLAY || `:${99 + (process.pid % 40)}`;
const WORKSPACE = path.join(ROOT, "ws", "probe");
// A non-table line, then a table, then another line — for probe 7.
const TABLES = "before line\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n\nafter line\n";
// Multi-line blocks for probe 8: a line above, a blank line, then the block.
const MATH = "above line\n\n$$\nx^2 + y^2\n$$\n";
const HTML = "above line\n\n<div>\nhello\n</div>\n";
// Same shape as MATH/HTML: line above, a blank line at offset 11, then a table.
const BLOCKTABLE = "above line\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\n";
// Inline constructs inside a fence, for the report in probe 8c.
const CODE = "before\n\n```\necho $HOME and $PATH\n**bold**\n[[link]]\n```\nafter\n";
// Two notes for the stale-save race (probe 10).
const RACE_A = "race A original\n";
const RACE_B = "race B original\n";
const RACE_MARKER = "TYPED_IN_A ";
// Inline marks outside a fence, for the regression probe 11.
const INLINE = "above\nplain **bold** and $x+y$ here\n";
// A note to type brackets into (probe 12).
const TYPE = "start\n";
// A note for Ctrl+click multi-cursor (probe 13).
const MULTI = "hello world\n";
// A note for heading/strikethrough shortcuts (probe 14).
const FMT = "plain line\n";
// A note with a task list, for the README audit probe 15.
const TASK = "above\n- [ ] todo\n";
// A note with a rendered table and a line after it (probe 17).
const GUTTER = "above\n\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |\nbelow\n";

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

/** Click an activity-ribbon button by its title (robust to icon order). */
async function openActivity(label) {
  const ok = await js(
    `const b = [...document.querySelectorAll('.activitybar .activity')]
       .find((x) => x.getAttribute('title') === ${JSON.stringify(label)});
     if (b) b.click();
     return !!b;`,
  );
  if (!ok) throw new Error(`no activity button titled ${JSON.stringify(label)}`);
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
const BACKSPACE = "\uE003";
const SHIFT = "\uE008";
const CTRL = "\uE009";
const ARROW_DOWN = "\uE015";

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

/**
 * A real pointer click at viewport coordinates, optionally with modifiers held
 * for the whole press (e.g. `pointerClick(x, y, [CTRL])`).
 */
async function pointerClick(x, y, hold = []) {
  const sources = [
    {
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x, y },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
        ...hold.map(() => ({ type: "pause", duration: 0 })),
      ],
    },
  ];
  if (hold.length) {
    sources.unshift({
      type: "key",
      id: "keys",
      actions: [
        ...hold.map((value) => ({ type: "keyDown", value })),
        { type: "pause", duration: 0 },
        { type: "pause", duration: 0 },
        ...[...hold].reverse().map((value) => ({ type: "keyUp", value })),
      ],
    });
  }
  await wd("POST", `/session/${sessionId}/actions`, { actions: sources });
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
  fs.mkdirSync(path.join(WORKSPACE, "dictionary"), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, "config"), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: WORKSPACE });
  // A grammar rule + default, so the Translator can load it (probe 22).
  fs.writeFileSync(
    path.join(WORKSPACE, "config", "grammar"),
    JSON.stringify(
      {
        rules: [
          {
            name: "SVO",
            description: "Subject Verb Object",
            slots: [
              { kind: "required_tag", tag: "Subject" },
              { kind: "required_tag", tag: "Verb" },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(WORKSPACE, "config", "translation"),
    JSON.stringify(
      {
        default_rule: "SVO",
        settings: {},
        grids: [],
        affixes: [],
        // A past-tense suffix on verbs, for probe 25.
        morphology: {
          features: [
            {
              id: "tense",
              label: "Tense",
              values: [
                { id: "present", label: "Present" },
                { id: "past", label: "Past" },
                { id: "future", label: "Future" },
              ],
            },
            {
              id: "number",
              label: "Number",
              values: [
                { id: "singular", label: "Singular" },
                { id: "plural", label: "Plural" },
              ],
            },
          ],
          paradigms: [
            {
              class: "verb",
              rows: [{ when: { tense: "past" }, surface: "i", kind: "suffix" }],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  // A tiny lexicon so the Translator has words to map (probe 19).
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "lex"),
    JSON.stringify(
      {
        name: "lex",
        tags: [
          {
            name: "wordname",
            description: "The base conlang spelling.",
            kind: "text",
            builtin: true,
          },
        ],
        entries: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            wordname: "kala",
            values: { definition: { type: "tag_list", value: ["dog"] } },
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            wordname: "velo",
            values: {
              definition: { type: "tag_list", value: ["to run"] },
              // A word class, so the paradigm can inflect it (probe 25).
              pos: { type: "tag_list", value: ["verb"] },
            },
          },
          // Two entries for one sense => a real conflict (probe 24).
          {
            id: "33333333-3333-4333-8333-333333333333",
            wordname: "paka",
            values: { definition: { type: "tag_list", value: ["to zzarg"] } },
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            wordname: "pako",
            values: { definition: { type: "tag_list", value: ["to zzarg"] } },
          },
          // Decoys: senses that merely *contain* "i"/"eat" (probe 24).
          {
            id: "55555555-5555-4555-8555-555555555555",
            wordname: "big",
            values: { definition: { type: "tag_list", value: ["big"] } },
          },
          {
            id: "66666666-6666-4666-8666-666666666666",
            wordname: "feat",
            values: { definition: { type: "tag_list", value: ["feature"] } },
          },
        ],
      },
      null,
      2,
    ),
  );
  const lines = Array.from(
    { length: 120 },
    (_, i) => `line ${String(i + 1).padStart(3, "0")}`,
  );
  fs.writeFileSync(path.join(WORKSPACE, "notes", "alpha.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "beta.md"), "beta note\n");
  fs.writeFileSync(path.join(WORKSPACE, "notes", "tables.md"), TABLES);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "math.md"), MATH);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "html.md"), HTML);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "blocktable.md"), BLOCKTABLE);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "code.md"), CODE);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "raceA.md"), RACE_A);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "raceB.md"), RACE_B);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "inline.md"), INLINE);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "type.md"), TYPE);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "multi.md"), MULTI);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "fmt.md"), FMT);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "task.md"), TASK);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "gutter.md"), GUTTER);
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
  // `PROBE_DELAY_MS` slows each step so a human can follow it on screen.
  const delay = Number(process.env.PROBE_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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

  if (process.env.PROBE_DISPLAY) {
    // Watch mode: drive the app on a display the user can see instead of a
    // headless Xvfb. Nothing is spawned here; the driver uses that DISPLAY.
    console.log(`probe: using existing display ${DISPLAY} (PROBE_DISPLAY)`);
  } else {
    spawnLogged("xvfb", "Xvfb", [DISPLAY, "-screen", "0", "1400x900x24"]);
    const socket = `/tmp/.X11-unix/X${DISPLAY.slice(1)}`;
    for (let i = 0; i < 50 && !fs.existsSync(socket); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!fs.existsSync(socket)) throw new Error("Xvfb did not start");
  }

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

  // -- probe 16: the brand is the new logo, not the old "L" ----------------
  // (The app has a single dark theme, so there is no light theme to check.)
  await probe("16-app-brand-logo", async () => {
    const brand = await js(
      `const b = document.querySelector('.brand');
       const img = b ? b.querySelector('img') : null;
       return {
         text: b ? b.textContent.trim() : null,
         imgs: b ? b.querySelectorAll('img').length : 0,
         natural: img ? img.naturalWidth : 0,
       };`,
    );
    if (brand.text && brand.text.length) {
      throw new Error(`brand still shows text: ${JSON.stringify(brand.text)}`);
    }
    if (brand.imgs < 1) throw new Error("brand has no <img>");
    if (!(brand.natural > 0)) {
      throw new Error(`logo image not loaded (naturalWidth=${brand.natural})`);
    }
  });

  // -- probe 17: a rendered block still shows its line number --------------
  await probe("17-rendered-block-line-numbers", async () => {
    await openNote("gutter.md");
    await waitEditorText("gutter.md", GUTTER);
    await focusEditor("gutter.md");
    await placeCursor("gutter.md", 1); // on line 1, so the table renders
    await waitJs(
      `!!document.querySelector('.cm-host[data-note="gutter.md"] .cm-table')`,
      { label: "table widget rendered" },
    );

    const gutter = await js(
      `return [...document.querySelectorAll('.cm-host[data-note="gutter.md"] .cm-lineNumbers .cm-gutterElement')]
         .map((el) => el.textContent)
         .filter((text) => text);`,
    );
    console.log("GUTTER", JSON.stringify(gutter));

    // Clicking the line after the table must land on it, not inside the table.
    const point = await js(`${viewScript("gutter.md")}
      const c = v.coordsAtPos(45);
      return c ? { x: c.left + 2, y: (c.top + c.bottom) / 2 } : null;`);
    if (!point) throw new Error("could not locate the line after the table");
    await pointerClick(point.x, point.y);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const anchor = (await readEditorState("gutter.md")).anchor;
    console.log("CLICK-ANCHOR", anchor);

    if (!gutter.includes("3")) {
      throw new Error(`gutter is missing the table's line number: ${JSON.stringify(gutter)}`);
    }
    if (anchor < 45 || anchor > 50) {
      throw new Error(`cursor landed at ${anchor}, expected on line 6 (45..50)`);
    }
  });

  // -- probe 18: math/HTML blocks are clickable and top-aligned ------------
  for (const [file, content, from, to, inner, widgetClass] of [
    ["html.md", HTML, 12, 30, ":scope > *", ".cm-html-block"],
    ["math.md", MATH, 12, 27, ".katex-display", ".cm-math-display"],
  ]) {
    await probe(`18-${file}-block-clickable-and-aligned`, async () => {
      await openNote(file);
      await waitEditorText(file, content);
      await focusEditor(file);
      await placeCursor(file, 1);
      await waitJs(
        `!!document.querySelector('.cm-host[data-note=${JSON.stringify(file)}] ${widgetClass}')`,
        { label: `${widgetClass} in ${file}` },
      );

      const geometry = await js(`${viewScript(file)}
        const widget = host.querySelector(${JSON.stringify(widgetClass)});
        const inner = widget ? widget.querySelector(${JSON.stringify(inner)}) : null;
        const c = v.coordsAtPos(${from});
        const wr = widget ? widget.getBoundingClientRect() : null;
        const ir = inner ? inner.getBoundingClientRect() : null;
        return {
          widgetTop: wr && Math.round(wr.top),
          widgetBottom: wr && Math.round(wr.bottom),
          innerTop: ir && Math.round(ir.top),
          lineTop: c && Math.round(c.top),
          point: wr ? { x: Math.round(wr.left + 20), y: Math.round(wr.top + 4) } : null,
        };`);
      console.log("BLOCK18", file, JSON.stringify(geometry));
      if (!geometry.point) throw new Error(`${file}: no block to click`);

      await pointerClick(geometry.point.x, geometry.point.y);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const anchor = (await readEditorState(file)).anchor;

      if (anchor < from || anchor > to) {
        throw new Error(
          `click did not enter the block: anchor=${anchor}, expected ${from}..${to}`,
        );
      }
      if (geometry.innerTop - geometry.lineTop > 10) {
        throw new Error(
          `block content is offset: innerTop=${geometry.innerTop} lineTop=${geometry.lineTop}`,
        );
      }
    });
  }

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

  // -- probe 7: table navigation, row append, undo, Tab outside ------------
  // Offsets in TABLES: header "h1"=15, "h2"=20, body "c1"=41, "c2"=46.
  await openNote("tables.md");
  await waitEditorText("tables.md", TABLES);

  await focusEditor("tables.md");
  await placeCursor("tables.md", 15);
  await pressKey(TAB);
  const afterTab = await readEditorState("tables.md");
  await probe("7a-tab-moves-to-the-next-cell", async () => {
    assertEqual(afterTab?.anchor, 20, "cursor after Tab");
  });

  await focusEditor("tables.md");
  await placeCursor("tables.md", 46); // last cell "c2"
  await pressKey(TAB);
  const grown = await editorText("tables.md");
  const grownState = await readEditorState("tables.md");
  await screenshot("p7-tab-append");
  await probe("7b-tab-appends-a-row-and-lands-in-it", async () => {
    const seeded = TABLES.split("\n").filter(Boolean).length;
    if (grown.split("\n").filter(Boolean).length !== seeded + 1) {
      throw new Error(`expected a new row: ${JSON.stringify(grown)}`);
    }
    const start = grown.indexOf("| h1");
    const end = grown.indexOf("after line");
    if (!(grownState.anchor >= start && grownState.anchor <= end)) {
      throw new Error(`cursor not in the table: ${grownState.anchor}`);
    }
  });

  await focusEditor("tables.md");
  await pressKey("z", [CTRL]);
  await waitEditorText("tables.md", TABLES);
  const undone7 = await readEditorState("tables.md");
  await screenshot("p7-undo");
  await probe("7c-undo-restores-the-table-and-the-cursor", async () => {
    assertEqual(await editorText("tables.md"), TABLES, "doc after undo");
    if (!(undone7.anchor >= TABLES.indexOf("| h1") && undone7.anchor <= TABLES.indexOf("after line"))) {
      throw new Error(`cursor not in the table: ${undone7.anchor}`);
    }
  });

  // -- click bridge: clicking a cell puts the cursor in its raw text --------
  await focusEditor("tables.md");
  await placeCursor("tables.md", 5); // cursor off the table → widget renders
  await waitJs(
    `!!document.querySelector('.cm-host[data-note="tables.md"] .cm-table')`,
    { label: "table widget rendered" },
  );
  await js(`const cell = document.querySelector(
      '.cm-host[data-note="tables.md"] .cm-table th:nth-child(2)');
    if (!cell) return false;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return true;`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const clickedCell = await readEditorState("tables.md");
  await screenshot("p7-click-bridge");
  await probe("7d-clicking-a-cell-places-the-cursor", async () => {
    assertEqual(clickedCell?.anchor, 20, "cursor after clicking the second header cell");
  });

  // -- Tab outside a table still indents -----------------------------------
  await focusEditor("tables.md");
  await placeCursor("tables.md", 5); // inside "before line", outside the table
  await pressKey(TAB);
  const indentDeadline = Date.now() + 2000;
  while (
    Date.now() < indentDeadline &&
    !(await editorText("tables.md")).startsWith("  before line")
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await probe("7e-tab-outside-a-table-still-indents", async () => {
    const text = await editorText("tables.md");
    if (!text.startsWith("  before line")) {
      throw new Error(`not indented: ${JSON.stringify(text.slice(0, 24))}`);
    }
  });

  // -- probe 8: multi-line math and HTML render as block widgets -----------
  for (const [file, content, widget] of [
    ["math.md", MATH, ".cm-math-display"],
    ["html.md", HTML, ".cm-html-block"],
  ]) {
    await probe(`8-${file}-block-widget-renders`, async () => {
      await openNote(file);
      // The tab switch replaces the buffer asynchronously; wait for the text.
      await waitEditorText(file, content, 12000);
      // Place the cursor on the line above the block, so it is not active.
      await focusEditor(file);
      await placeCursor(file, 1);
      await waitJs(
        `!!document.querySelector('.cm-host[data-note=${JSON.stringify(file)}] ${widget}')`,
        { timeout: 8000, label: `${widget} in ${file}` },
      );
    });
  }

  // -- probe 8c: inline marks must NOT apply inside a fence ----------------
  await probe("8c-inline-marks-stay-raw-inside-a-fence", async () => {
    await openNote("code.md");
    await waitEditorText("code.md", CODE);
    await focusEditor("code.md");
    await placeCursor("code.md", 1); // cursor off the fence
    const info = await js(
      `const host = document.querySelector('.cm-host[data-note="code.md"]');
       const content = host.querySelector('.cm-content');
       return {
         strong: content.querySelectorAll('.cm-strong').length,
         inlineMath: content.querySelectorAll('.cm-math').length,
         displayMath: content.querySelectorAll('.cm-math-display').length,
         text: content.textContent,
       };`,
    );
    console.log("INLINE-IN-FENCE", JSON.stringify(info));
    if (info.strong !== 0) throw new Error(`bold concealed in a fence: ${info.strong}`);
    if (info.inlineMath !== 0) throw new Error(`math rendered in a fence: ${info.inlineMath}`);
    if (!info.text.includes("**bold**")) throw new Error("bold text not raw");
    if (!info.text.includes("$HOME")) throw new Error("math text not raw");
  });

  // -- probe 11: the same inline marks OUTSIDE a fence still render --------
  await probe("11-inline-marks-still-render-outside-a-fence", async () => {
    await openNote("inline.md");
    await waitEditorText("inline.md", INLINE);
    await focusEditor("inline.md");
    await placeCursor("inline.md", 1); // cursor on the line above
    const info = await js(
      `const host = document.querySelector('.cm-host[data-note="inline.md"]');
       const content = host.querySelector('.cm-content');
       return {
         strong: content.querySelectorAll('.cm-strong').length,
         inlineMath: content.querySelectorAll('.cm-math').length,
       };`,
    );
    console.log("INLINE-OUTSIDE", JSON.stringify(info));
    if (info.strong < 1) throw new Error("bold not concealed outside a fence");
    if (info.inlineMath < 1) throw new Error("math not rendered outside a fence");
  });

  // -- probe 12: brackets auto-close; quotes do not; Backspace pairs ---------
  await probe("12-bracket-auto-close", async () => {
    await openNote("type.md");
    await waitEditorText("type.md", TYPE);
    await focusEditor("type.md");
    await placeCursor("type.md", 5);

    await pressKey("(");
    assertEqual(await editorText("type.md"), "start()\n", "after (");
    assertEqual((await readEditorState("type.md")).anchor, 6, "caret between ()");

    await placeCursor("type.md", 7);
    await pressKey("[");
    await pressKey("[");
    assertEqual(await editorText("type.md"), "start()[[]]\n", "after [[");
    await pressKey(BACKSPACE);
    assertEqual(await editorText("type.md"), "start()[]\n", "Backspace removes the pair");

    // At the empty end of the line (next char is a line break), { closes.
    await placeCursor("type.md", 9);
    await pressKey("{");
    assertEqual(await editorText("type.md"), "start()[]{}\n", "after {");
  });

  // -- probe 13: Ctrl+click adds a second cursor ---------------------------
  await probe("13-ctrl-click-adds-a-cursor", async () => {
    await openNote("multi.md");
    await waitEditorText("multi.md", MULTI);
    await focusEditor("multi.md");
    await placeCursor("multi.md", 0);
    const point = await js(`${viewScript("multi.md")}
      const c = v.coordsAtPos(6);
      return c ? { x: c.left + 1, y: (c.top + c.bottom) / 2 } : null;`);
    if (!point) throw new Error("could not locate position 6");
    await pointerClick(point.x, point.y, [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const ranges = await js(
      `${viewScript("multi.md")} return v.state.selection.ranges.length;`,
    );
    if (ranges !== 2) throw new Error(`expected 2 cursors, got ${ranges}`);
    // Typing with two cursors inserts at both.
    await pressKey("X");
    assertEqual(await editorText("multi.md"), "Xhello Xworld\n", "typed at both cursors");
  });

  // -- probe 14: heading and strikethrough shortcuts -----------------------
  await probe("14-heading-and-strikethrough-shortcuts", async () => {
    await openNote("fmt.md");
    await waitEditorText("fmt.md", FMT);
    await focusEditor("fmt.md");
    await placeCursor("fmt.md", 2);

    await pressKey("1", [CTRL]);
    assertEqual(await editorText("fmt.md"), "# plain line\n", "Ctrl+1");
    await pressKey("1", [CTRL]);
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+1 again removes it");
    await pressKey("2", [CTRL]);
    assertEqual(await editorText("fmt.md"), "## plain line\n", "Ctrl+2");
    await pressKey("0", [CTRL]);
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+0 clears");

    await pressKey("x", [CTRL, SHIFT]);
    assertEqual(await editorText("fmt.md"), "~~plain line~~\n", "Ctrl+Shift+X");
    await pressKey("x", [CTRL, SHIFT]);
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+Shift+X toggles off");

    // The bindings are editor-local: focusing the toolbar must not edit.
    await js(`document.querySelector('.editor-toolbar')?.focus(); return true;`);
    await pressKey("1", [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+1 outside the editor");
  });

  // -- probe 15: README claim audit ----------------------------------------
  await probe("15-readme-claim-audit", async () => {
    const audit = [];
    const check = (name, ok, detail = "") => audit.push({ name, ok, detail });

    check(
      "workspace boots into the seeded workspace",
      await js(`return (document.querySelector('.statusbar')?.textContent || '').includes('probe')`),
    );

    await openNote("inline.md");
    await waitEditorText("inline.md", INLINE);
    const labels = await js(
      `return [...document.querySelectorAll('.editor-toolbar button')].map((b) => b.getAttribute('aria-label') || '').filter(Boolean);`,
    );
    for (const want of [
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Insert table",
    ]) {
      check(`formatting toolbar: ${want}`, labels.includes(want));
    }

    await openNote("task.md");
    await waitEditorText("task.md", TASK);
    await focusEditor("task.md");
    await placeCursor("task.md", 1);
    const tasks = await js(
      `return document.querySelectorAll('.cm-host[data-note="task.md"] .cm-task').length;`,
    );
    check("task list renders a checkbox", tasks >= 1, `count=${tasks}`);

    await openNote("inline.md");
    await waitEditorText("inline.md", INLINE);
    await focusEditor("inline.md");
    await placeCursor("inline.md", 1);
    const preview = await js(
      `const c = document.querySelector('.cm-host[data-note="inline.md"] .cm-content');
       return { strong: c.querySelectorAll('.cm-strong').length, math: c.querySelectorAll('.cm-math').length };`,
    );
    check("live preview conceals bold", preview.strong >= 1, `strong=${preview.strong}`);
    check("KaTeX inline math renders", preview.math >= 1, `math=${preview.math}`);

    await openNote("blocktable.md");
    await waitEditorText("blocktable.md", BLOCKTABLE);
    await focusEditor("blocktable.md");
    await placeCursor("blocktable.md", 1);
    const tables = await js(
      `return document.querySelectorAll('.cm-host[data-note="blocktable.md"] .cm-table').length;`,
    );
    check("table renders as a widget", tables >= 1, `count=${tables}`);

    // Dictionary: reach the tables panel and create a table to open the grid.
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.sidebar .pane-head')`, {
      label: "tables panel",
    });
    check(
      "dictionary tables panel",
      await js(`return !!document.querySelector('.sidebar .pane-head .pane-title')`),
    );
    await js(
      `document.querySelector('.sidebar .pane-head .actions button:nth-of-type(2)').click(); return true;`,
    );
    await waitJs(`!!document.querySelector('.sidebar input.new-input')`, {
      label: "new table input",
    });
    await js(`const input = document.querySelector('.sidebar input.new-input');
      input.value = "audit";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;`);
    await waitJs(`!!document.querySelector('.grid-view')`, { label: "grid view" });
    check("dictionary grid opens", true);

    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, { label: "translation view" });
    check("translation view opens", true);

    await openActivity("Source Control");
    await waitJs(`!!document.querySelector('.git-panel')`, { label: "source control" });
    check("source control panel opens", true);

    await openActivity("Notes");

    console.log("README-AUDIT", JSON.stringify(audit));
    const failed = audit.filter((entry) => !entry.ok);
    if (failed.length) throw new Error(`README claims failed: ${JSON.stringify(failed)}`);
  });

  // -- probe 9: ArrowDown from above reveals each block's raw text ---------
  await probe("9-arrowdown-into-blocks", async () => {
    const cases = [
      ["blocktable.md", 11, ".cm-table", "| h1 | h2 |"],
      ["math.md", 11, ".cm-math-display", "$$"],
      ["html.md", 11, ".cm-html-block", "<div>"],
    ];
    const report = [];
    for (const [file, blank, widget, marker] of cases) {
      await openNote(file);
      await focusEditor(file);
      await placeCursor(file, blank);
      await pressKey(ARROW_DOWN);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const state = await readEditorState(file);
      const dom = await js(
        `const host = document.querySelector('.cm-host[data-note=${JSON.stringify(file)}]');
         return {
           widget: !!host.querySelector(${JSON.stringify(widget)}),
           raw: host.querySelector('.cm-content').textContent.includes(${JSON.stringify(marker)}),
         };`,
      );
      report.push({ file, anchor: state.anchor, stuck: state.anchor === blank, ...dom });
    }
    console.log("ARROWDOWN-BLOCKS", JSON.stringify(report));
    const stuck = report.filter((entry) => entry.stuck);
    if (stuck.length) throw new Error(`cursor stuck: ${JSON.stringify(stuck)}`);
  });

  // -- probe 10: a stale save must not touch the newly shown note ----------
  // Type in A and switch to B with no settle delay: A's autosave is still in
  // flight, so its completion must not overwrite B's content or hash.
  await probe("10-stale-save-does-not-touch-another-note", async () => {
    await openNote("raceA.md");
    await waitEditorText("raceA.md", RACE_A);
    await focusEditor("raceA.md");
    await js(`${viewScript("raceA.md")}
      v.dispatch({ changes: { from: 0, insert: ${JSON.stringify(RACE_MARKER)} } });
      return true;`);
    await openNote("raceB.md");
    await new Promise((resolve) => setTimeout(resolve, 2500));

    assertEqual(await editorText("raceB.md"), RACE_B, "B editor text");
    assertEqual(
      fs.readFileSync(path.join(WORKSPACE, "notes", "raceB.md"), "utf8"),
      RACE_B,
      "B file on disk",
    );
    const aDisk = fs.readFileSync(path.join(WORKSPACE, "notes", "raceA.md"), "utf8");
    if (!aDisk.includes(RACE_MARKER)) {
      throw new Error(`A file missing the typed text: ${JSON.stringify(aDisk)}`);
    }
    const banner = await js(
      `return !!document.querySelector('.cm-host[data-note="raceB.md"] .conflict-banner');`,
    );
    if (banner) throw new Error("conflict banner shown on B");
  });

  // -- probe 19: word-for-word translation mode ----------------------------
  await probe("19-word-for-word-mode", async () => {
    // Open the Translator.
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });

    // Switch to word-for-word.
    const switched = await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Word for word');
       if (b) b.click();
       return !!b;`,
    );
    if (!switched) throw new Error("no word-for-word mode button");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const tree = await js(
      `return {
         canvas: !!document.querySelector('.clause-canvas'),
         palette: !!document.querySelector('.palette-row'),
       };`,
    );
    if (tree.canvas || tree.palette) {
      throw new Error(`rule-tree controls shown in direct mode: ${JSON.stringify(tree)}`);
    }

    // "kala" is a conlang wordname (pass-through); "run" matches velo.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'kala run';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await js(`document.querySelector('.runner .translate').click(); return true;`);
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').includes('kala velo')`,
      { label: "word-for-word output" },
    );
    const output = await js(
      `return document.querySelector('.runner .output').textContent.trim();`,
    );
    assertEqual(output, "kala velo", "word-for-word output");

    // A missing word surfaces in the lazy "missing words" panel.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'dog fly';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await js(`document.querySelector('.runner .translate').click(); return true;`);
    await waitJs(
      `(() => {
         const r = document.querySelector('.runner');
         return !!r && [...r.querySelectorAll('.token-rows .token-row.missing')]
           .some((row) => row.querySelector('.token-english')?.textContent.trim() === 'fly');
       })()`,
      { label: "missing word row" },
    );
  });

  // -- probe 20: IPA chart builder persists the phoneme inventory ----------
  await probe("20-ipa-chart-inventory", async () => {
    await openActivity("Phonology");
    await waitJs(`!!document.querySelector('.phonology .ipa-table')`, {
      label: "phonology view",
    });

    const pick = async (symbol) =>
      js(
        `const b = [...document.querySelectorAll('.phonology .ipa-cell button')]
           .find((x) => x.textContent.trim() === ${JSON.stringify(symbol)});
         if (b) b.click();
         return !!b;`,
      );

    if (!(await pick("k"))) throw new Error("no 'k' button on the chart");
    if (!(await pick("a"))) throw new Error("no 'a' button on the chart");

    await waitJs(
      `[...document.querySelectorAll('.phonology .ipa-cell button')]
         .filter((b) => b.classList.contains('active')).length >= 2`,
      { label: "chart symbols active" },
    );
    const counts = await js(
      `return document.querySelector('.phonology .phonology-bar .muted')?.textContent ?? '';`,
    );
    if (!/1/.test(counts)) throw new Error(`counts not updated: ${JSON.stringify(counts)}`);

    // The autosave writes config/phonology on disk.
    const configPath = path.join(WORKSPACE, "config", "phonology");
    const deadline = Date.now() + 6000;
    let saved = null;
    while (Date.now() < deadline) {
      try {
        saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const symbols = (saved.phonemes ?? []).map((p) => p.symbol);
        if (symbols.includes("k") && symbols.includes("a")) break;
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const symbols = (saved?.phonemes ?? []).map((p) => p.symbol);
    if (!symbols.includes("k") || !symbols.includes("a")) {
      throw new Error(`inventory not persisted: ${JSON.stringify(saved)}`);
    }
    const kinds = Object.fromEntries((saved.phonemes ?? []).map((p) => [p.symbol, p.kind]));
    assertEqual(kinds.k, "consonant", "k kind");
    assertEqual(kinds.a, "vowel", "a kind");
  });

  // -- probe 21: non-blocking phonotactic warnings on word names -----------
  await probe("21-phonotactic-word-warnings", async () => {
    // The inventory {k, a} was saved by probe 20.
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, {
      label: "tables panel",
    });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await waitJs(
      `document.querySelectorAll('.dict-grid td.wordname-col input').length >= 2`,
      { label: "lex rows" },
    );
    // Let the batched check land.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const kalaWarns = await js(
      `const td = [...document.querySelectorAll('.dict-grid td.wordname-col')]
         .find((x) => x.querySelector('input')?.value === 'kala');
       return !!td?.querySelector('.word-warning');`,
    );
    if (!kalaWarns) throw new Error("'kala' should warn (l is not in the inventory)");

    // Non-blocking: rename to a valid word and the warning clears.
    await js(`const td = [...document.querySelectorAll('.dict-grid td.wordname-col')]
        .find((x) => x.querySelector('input')?.value === 'kala');
      const i = td.querySelector('input');
      i.focus();
      i.value = 'kaka';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      return true;`);
    await waitJs(
      `(() => {
         const td = [...document.querySelectorAll('.dict-grid td.wordname-col')]
           .find((x) => x.querySelector('input')?.value === 'kaka');
         return !!td && !td.querySelector('.word-warning');
       })()`,
      { label: "warning cleared after edit" },
    );
  });

  // -- probe 22: the Translator loads grammar rules -------------------------
  await probe("22-translator-loads-grammar-rule", async () => {
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });
    // Switch back to the rule-tree mode.
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Rule tree');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.clause-canvas')`, {
      label: "clause canvas",
    });
    // The default rule ("SVO") auto-loads two slots.
    await waitJs(
      `document.querySelectorAll('.clause-canvas .slot-card').length === 2`,
      { label: "grammar slots loaded" },
    );
    const values = await js(
      `return [...document.querySelectorAll('.translation-toolbar select option')]
         .map((o) => o.value)
         .filter(Boolean);`,
    );
    if (!values.includes("SVO")) {
      throw new Error(`grammar rule missing from the picker: ${JSON.stringify(values)}`);
    }
  });

  // -- probe 23: word-for-word live rows + inline add ----------------------
  await probe("23-word-for-word-live-rows", async () => {
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Word for word');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.runner textarea')`, {
      label: "runner",
    });

    // Live preview: no button click, the rows appear as we type.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'dog run';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitJs(
      `document.querySelectorAll('.runner .token-rows .token-row').length === 2`,
      { label: "two live rows" },
    );
    const pairs = await js(
      `return [...document.querySelectorAll('.runner .token-rows .token-row')].map((r) => ({
         english: r.querySelector('.token-english')?.textContent.trim(),
         conlang: r.querySelector('.token-conlang')?.textContent.trim(),
       }));`,
    );
    // Probe 21 renamed kala -> kaka (still the entry for "dog").
    assertEqual(pairs[0]?.english, "dog", "row 0 english");
    assertEqual(pairs[0]?.conlang, "kaka", "row 0 conlang");
    assertEqual(pairs[1]?.english, "run", "row 1 english");
    assertEqual(pairs[1]?.conlang, "velo", "row 1 conlang");
    assertEqual(
      await js(`return document.querySelector('.runner .output').textContent.trim()`),
      "kaka velo",
      "output",
    );

    // A missing token gets an inline create; creating it updates the output.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'dog fly';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitJs(
      `[...document.querySelectorAll('.runner .token-rows .token-row.missing')]
         .some((r) => r.querySelector('.token-english')?.textContent.trim() === 'fly')`,
      { label: "fly row missing" },
    );
    await js(`const row = [...document.querySelectorAll('.runner .token-rows .token-row.missing')]
        .find((r) => r.querySelector('.token-english')?.textContent.trim() === 'fly');
      const input = row.querySelector('input');
      input.value = 'flai';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      row.querySelectorAll('button')[0].click();
      return true;`);
    await waitJs(
      `(() => {
         const rows = [...document.querySelectorAll('.runner .token-rows .token-row')];
         const fly = rows.find((r) => r.querySelector('.token-english')?.textContent.trim() === 'fly');
         return !!fly && !fly.classList.contains('missing') &&
           fly.querySelector('.token-conlang')?.textContent.trim() === 'flai';
       })()`,
      { label: "fly resolved after add" },
    );
    assertEqual(
      await js(`return document.querySelector('.runner .output').textContent.trim()`),
      "kaka flai",
      "output after add",
    );
  });

  // -- probe 24: tighter matching + working conflict picker ----------------
  await probe("24-tighter-matching-and-conflict-picker", async () => {
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Word for word');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.runner textarea')`, { label: "runner" });

    const type = async (text) =>
      js(`const t = document.querySelector('.runner textarea');
        t.value = ${JSON.stringify(text)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;`);

    // "i" and "eat" are missing words, not fuzzy multi-candidate conflicts.
    await type("i");
    await waitJs(
      `(() => {
         const r = [...document.querySelectorAll('.runner .token-rows .token-row')]
           .find((x) => x.querySelector('.token-english')?.textContent.trim() === 'i');
         return !!r && r.classList.contains('missing');
       })()`,
      { label: "i is missing" },
    );
    await type("eat");
    await waitJs(
      `(() => {
         const r = [...document.querySelectorAll('.runner .token-rows .token-row')]
           .find((x) => x.querySelector('.token-english')?.textContent.trim() === 'eat');
         return !!r && r.classList.contains('missing');
       })()`,
      { label: "eat is missing" },
    );

    // "zzarg" really is ambiguous; the picker lists both candidates.
    await type("zzarg");
    await waitJs(
      `document.querySelectorAll('.runner .token-rows .token-row select option').length >= 3`,
      { label: "conflict picker populated" },
    );
    const options = await js(
      `return [...document.querySelectorAll('.runner .token-rows .token-row select option')]
         .map((o) => o.textContent.trim())
         .filter(Boolean);`,
    );
    if (
      !options.some((label) => label.startsWith("paka")) ||
      !options.some((label) => label.startsWith("pako"))
    ) {
      throw new Error(`picker missing candidates: ${JSON.stringify(options)}`);
    }

    // Choosing one resolves the conflict and updates the output.
    await js(
      `const row = document.querySelector('.runner .token-rows .token-row');
       const select = row.querySelector('select');
       const option = [...select.options].find((o) => o.textContent.includes('pako'));
       select.value = option.value;
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').includes('pako')`,
      { label: "conflict resolved" },
    );
  });

  // -- probe 25: feature bar applies a paradigm affix ----------------------
  await probe("25-paradigm-tense-affix", async () => {
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Word for word');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.feature-bar')`, {
      label: "feature bar",
    });

    const pickFeature = (label) =>
      js(
        `const b = [...document.querySelectorAll('.feature-bar button')]
           .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
         if (b) b.click();
         return !!b;`,
      );

    // Select "Past": the verb velo (pos=verb) takes its past suffix "i".
    if (!(await pickFeature("Past"))) throw new Error("no Past button");
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'run';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'veloi'`,
      { label: "past suffix applied" },
    );
    const gloss = await js(
      `return document.querySelector('.runner')?.textContent ?? '';`,
    );
    if (!gloss.includes("PAST")) throw new Error("feature label missing from gloss");

    // Clearing the feature removes the ending again.
    await js(
      `const b = [...document.querySelectorAll('.feature-bar button.active')]
         .find((x) => x.textContent.trim() === 'Past');
       if (b) b.click();
       return true;`,
    );
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'velo'`,
      { label: "ending removed" },
    );
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
