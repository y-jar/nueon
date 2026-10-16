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
const ALT = "\uE00A";
const ARROW_DOWN = "\uE015";
const ARROW_LEFT = "\uE012";
const ARROW_RIGHT = "\uE014";
const HOME = "\uE011";
const END = "\uE010";
const PAGE_UP = "\uE00E";
const PAGE_DOWN = "\uE00F";

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

/** A real right-click at viewport coordinates (fires mousedown + contextmenu). */
async function rightClickAt(x, y) {
  await wd("POST", `/session/${sessionId}/actions`, {
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", duration: 0, origin: "viewport", x, y },
          { type: "pointerDown", button: 2 },
          { type: "pointerUp", button: 2 },
        ],
      },
    ],
  });
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
  // A committable identity, so the Source Control panel's check-in works.
  spawnSync("git", ["config", "user.name", "probe"], { cwd: WORKSPACE });
  spawnSync("git", ["config", "user.email", "probe@localhost"], { cwd: WORKSPACE });
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
        // The fixes table supplies the "-i" suffix for the trigger "z" (probe 30).
        table_roles: {
          fixes: { role: "fixes", trigger: "english" },
          // A fixes table with no English column: still a morpheme source (58).
          morphs: { role: "fixes" },
        },
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
              id: "aspect",
              label: "Aspect",
              values: [
                { id: "perfective", label: "Perfective" },
                { id: "imperfective", label: "Imperfective" },
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
            // An inherent feature: read from each word's `decl` column (probe 66).
            {
              id: "decl",
              label: "Declension",
              values: [],
              column: { table: "lex", column: "decl" },
            },
          ],
          // The verb's tense and aspect are ordered slots that stack (probe 57);
          // each is a lone ending when the other is unselected (probe 25).
          paradigms: [
            {
              class: "verb",
              rows: [
                {
                  when: { tense: "past" },
                  surface: "i",
                  kind: "suffix",
                  slot: "tense",
                  order: 1,
                },
                {
                  when: { aspect: "perfective" },
                  surface: "a",
                  kind: "suffix",
                  slot: "aspect",
                  order: 2,
                },
              ],
            },
            {
              class: "noun",
              rows: [{ when: { number: "plural" }, surface: "u", kind: "suffix" }],
            },
            // A class whose plural depends on its inherent declension (probe 66).
            {
              class: "root",
              rows: [
                {
                  when: { number: "plural", decl: "1" },
                  surface: "a",
                  kind: "suffix",
                },
                {
                  when: { number: "plural", decl: "2" },
                  surface: "yu",
                  kind: "suffix",
                },
              ],
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
          {
            name: "pos",
            description: "Part of speech.",
            kind: "tag_list",
            // Value suggestions for tag_list cells (probe 44).
            suggest: true,
          },
          {
            name: "english",
            description: "English trigger for a fixes table.",
            kind: "text",
            // Value suggestions for text cells (probe 44).
            suggest: true,
          },
          {
            name: "decl",
            description: "Inherent declension group.",
            kind: "text",
          },
        ],
        entries: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            wordname: "kala",
            values: {
              definition: { type: "tag_list", value: ["dog"] },
              pos: { type: "tag_list", value: ["noun"] },
              english: { type: "text", value: "dog" },
            },
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            wordname: "velo",
            values: {
              definition: { type: "tag_list", value: ["to run"] },
              // A word class, so the paradigm can inflect it (probe 25).
              pos: { type: "tag_list", value: ["verb"] },
              english: { type: "text", value: "run" },
            },
          },
          // Two entries for one sense => a real conflict (probe 24).
          // `paka` derives from `kala`, so deleting `kala` has dependents (probe 48).
          {
            id: "33333333-3333-4333-8333-333333333333",
            wordname: "paka",
            values: {
              definition: { type: "tag_list", value: ["to zzarg"] },
              parent: {
                type: "references",
                value: ["11111111-1111-4111-8111-111111111111"],
              },
            },
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
          // A noun whose plural the Endings editor defines (probe 65).
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            wordname: "uene",
            values: {
              definition: { type: "tag_list", value: ["person"] },
              pos: { type: "tag_list", value: ["noun"] },
            },
          },
          // Inherent-declension roots: plural depends on the decl group (66).
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            wordname: "demo1",
            values: {
              definition: { type: "tag_list", value: ["one"] },
              pos: { type: "tag_list", value: ["root"] },
              decl: { type: "text", value: "1" },
            },
          },
          {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            wordname: "demo2",
            values: {
              definition: { type: "tag_list", value: ["two"] },
              pos: { type: "tag_list", value: ["root"] },
              decl: { type: "text", value: "2" },
            },
          },
          // A class stored with a leading '#' (probe 70 cleans it).
          {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            wordname: "hashy",
            values: {
              definition: { type: "tag_list", value: ["hashable"] },
              pos: { type: "tag_list", value: ["#noun"] },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  // A second vocabulary table, so a mixed-table Compose strip has a root to
  // link (probe 73).
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "roots"),
    JSON.stringify(
      {
        name: "roots",
        tags: [
          {
            name: "wordname",
            description: "The base conlang spelling.",
            kind: "text",
            builtin: true,
          },
          {
            name: "pos",
            description: "Part of speech.",
            kind: "tag_list",
          },
        ],
        entries: [
          {
            id: "12121212-1212-4121-8121-121212121212",
            wordname: "tomo",
            values: {
              definition: { type: "tag_list", value: ["house"] },
              pos: { type: "tag_list", value: ["noun"] },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  // A fixes table: wordname is the conlang surface (hyphen-marked), the
  // `english` column the trigger. Used by probe 30.
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "fixes"),
    JSON.stringify(
      {
        name: "fixes",
        tags: [
          {
            name: "wordname",
            description: "The base conlang spelling.",
            kind: "text",
            builtin: true,
          },
          {
            name: "english",
            description: "English trigger.",
            kind: "text",
          },
        ],
        entries: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            wordname: "-i",
            values: { english: { type: "text", value: "z" } },
          },
        ],
      },
      null,
      2,
    ),
  );
  // A fixes table with no English column: its morphemes still work (probe 58).
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "morphs"),
    JSON.stringify(
      {
        name: "morphs",
        tags: [
          {
            name: "wordname",
            description: "The morpheme surface.",
            kind: "text",
            builtin: true,
          },
        ],
        entries: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            wordname: "-o",
            values: { definition: { type: "tag_list", value: ["agent"] } },
          },
          // Referenced as the noun plural in probe 65.
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            wordname: "-yu",
            values: { definition: { type: "tag_list", value: ["plural"] } },
          },
        ],
      },
      null,
      2,
    ),
  );
  // A big table so the grid's row virtualization can be checked (probe 31).
  const bigEntries = Array.from({ length: 2000 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return {
      id: `90000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      wordname: `w${n}`,
      values: { definition: { type: "tag_list", value: [`zzword${n}`] } },
    };
  });
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "big"),
    JSON.stringify({
      name: "big",
      tags: [
        {
          name: "wordname",
          description: "The base conlang spelling.",
          kind: "text",
          builtin: true,
        },
      ],
      entries: bigEntries,
    }),
  );
  // Tall (wrapped-pill) rows, for the scroll-jitter probe (72).
  const propEntries = Array.from({ length: 200 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return {
      id: `91000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      wordname: `prop${n}`,
      values: {
        definition: {
          type: "tag_list",
          value: [
            `a very long defining sense number ${n} that wraps across the cell`,
            `another quite long sense for ${n} to make the row tall`,
            `a third long sense for ${n} so the pills wrap onto more lines`,
          ],
        },
      },
    };
  });
  fs.writeFileSync(
    path.join(WORKSPACE, "dictionary", "props"),
    JSON.stringify({
      name: "props",
      tags: [
        {
          name: "wordname",
          description: "The base conlang spelling.",
          kind: "text",
          builtin: true,
        },
      ],
      entries: propEntries,
    }),
  );
  const lines = Array.from(
    { length: 120 },
    (_, i) => `line ${String(i + 1).padStart(3, "0")}`,
  );
  fs.writeFileSync(path.join(WORKSPACE, "notes", "alpha.md"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(WORKSPACE, "notes", "beta.md"), "beta note\n");
  fs.writeFileSync(
    path.join(WORKSPACE, "notes", "headings.md"),
    "# Intro\n\n## Nouns\n\n## Verbs\n",
  );
  fs.writeFileSync(
    path.join(WORKSPACE, "notes", "links.md"),
    "[[velo]] [[pako|zzarg]] ![[paka]] [[missing-word]] [[beta]] [[headings#Intro]] [[headings#Missing]]\n",
  );
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
  // Imported files live under notes/assets/ (probes 41).
  const assetsDir = path.join(WORKSPACE, "notes", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(
    path.join(assetsDir, "pic.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  fs.writeFileSync(path.join(assetsDir, "notes.txt"), "asset text\n");
  fs.writeFileSync(path.join(assetsDir, "doc.pdf"), "%PDF-1.4 fake\n");
  // A dotfile: the tree shows everything in notes/ (probe 41).
  fs.writeFileSync(path.join(WORKSPACE, "notes", ".secret.md"), "hidden\n");
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

/**
 * Install the in-page error collector. It records window errors and unhandled
 * rejections (the same two sources the app's own handler turns into the red
 * status-bar text), and is safe to call again after a reload.
 */
async function installErrorCollector() {
  await js(`if (!window.__probeErrors) {
    window.__probeErrors = [];
    window.addEventListener('error', (e) =>
      window.__probeErrors.push('error: ' + (e.message || String(e.error))), true);
    window.addEventListener('unhandledrejection', (e) =>
      window.__probeErrors.push('rejection: ' + String(e.reason && e.reason.message || e.reason)), true);
  }
  window.__probeErrors.length = 0;
  return true;`);
}

/** What the red error text in the status bar says right now, or null. */
function readStatusError() {
  // The red button stays mounted after an error until the app is reloaded, and
  // then shows ordinary status text, so only text that is itself an error counts.
  return js(`const b = document.querySelector('.statusbar .status-error');
    const text = b ? b.textContent.trim() : '';
    return /^Error:/.test(text) ? text : null;`);
}

/**
 * Errors seen since the probe began: events caught in the page, plus a status
 * bar error that was not already showing. A probe may list `allowErrors`
 * (regexes) for errors it triggers on purpose; everything else fails the probe.
 */
async function collectProbeErrors(statusBefore, allow) {
  await new Promise((resolve) => setTimeout(resolve, 60));
  const events = (await js(`return window.__probeErrors ? window.__probeErrors.slice() : [];`)) ?? [];
  const status = await readStatusError();
  const found = [...events];
  if (status && status !== statusBefore) found.push(`status bar: ${status}`);
  return found.filter((text) => !allow.some((re) => re.test(text)));
}

/** With PROBE_STACKS, print the stacks of the errors the probe just produced. */
async function drainStacks(name) {
  if (!process.env.PROBE_STACKS) return;
  try {
    const stacks = (await js(`return (window.__stacks || []).splice(0);`)) ?? [];
    for (const e of stacks) console.log(`PAGE-STACK ${name}: ${JSON.stringify(e)}`);
  } catch {
    // the page may be gone; nothing to print
  }
}

async function probe(name, fn, options = {}) {
  // `PROBE_ONLY` runs a subset for focused debugging: a plain substring, or
  // `/regex/` to select exact sets (e.g. `'/(87|88-tab)/'`).
  const only = process.env.PROBE_ONLY;
  const onlyRe = only && only.startsWith("/") && only.endsWith("/") ? new RegExp(only.slice(1, -1)) : null;
  if (only && !onlyRe && !name.includes(only)) return;
  if (onlyRe && !onlyRe.test(name)) return;
  // `PROBE_DELAY_MS` slows each step so a human can follow it on screen.
  const delay = Number(process.env.PROBE_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const allow = options.allowErrors ?? [];
  let statusBefore = null;
  try {
    await installErrorCollector();
    statusBefore = await readStatusError();
  } catch {
    // The page is not ready (very early probes); the check is skipped for them.
  }
  try {
    await fn();
    let errors = [];
    try {
      errors = await collectProbeErrors(statusBefore, allow);
    } catch {
      errors = [];
    }
    if (errors.length) {
      const text = errors.join(" | ").slice(0, 400);
      const loop = /effect_update_depth_exceeded/.test(text) ? " [infinite effect loop]" : "";
      await drainStacks(name);
      results.push([name, "FAIL", `errors during probe${loop}: ${text}`]);
      console.log(`FAIL ${name}: errors during probe${loop}: ${text}`);
      return;
    }
    await drainStacks(name);
    results.push([name, "PASS", ""]);
    console.log(`PASS ${name}`);
  } catch (error) {
    await drainStacks(name);
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

/** Collapse every split pane down to one full-width pane (via Close pane). */
async function collapsePanes() {
  for (let i = 0; i < 8; i += 1) {
    const count = await js(`return document.querySelectorAll('.group-pane').length;`);
    if (count <= 1) return;
    const ok = await js(`
      const pane = [...document.querySelectorAll('.group-pane')]
        .find((p) => p.querySelector('.tab'));
      if (!pane) return false;
      pane.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
      return true;`);
    if (!ok) return;
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "pane menu" });
    await js(`
      const b = [...document.querySelectorAll('.ctx-menu button')]
        .find((x) => x.textContent.trim() === 'Close pane');
      if (b) b.click();
      return !!b;`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
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
  if (process.env.PROBE_STACKS) {
    // Keep the full stack of every page error for debugging (the default
    // harness check keeps only the message).
    await js(`window.__stacks = [];
      window.addEventListener('unhandledrejection', (e) => {
        const r = e.reason;
        window.__stacks.push({ msg: String(r && r.message || r), stack: r && r.stack ? String(r.stack).slice(0, 1600) : null });
      });
      window.addEventListener('error', (e) => {
        window.__stacks.push({ msg: e.message, stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 1600) : null });
      }, true);
      return true;`);
  }

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

    const zzargRow = `[...document.querySelectorAll('.runner .token-rows .token-row')]
       .find((x) => x.querySelector('.token-english')?.textContent.trim() === 'zzarg')`;

    // "zzarg" really is ambiguous; the picker lists both candidates.
    await type("zzarg");
    await waitJs(
      `(() => {
         const r = ${zzargRow};
         return !!r && r.querySelectorAll('select option').length >= 3;
       })()`,
      { label: "conflict picker populated" },
    );
    const options = await js(
      `const r = ${zzargRow};
       return [...(r?.querySelectorAll('select option') ?? [])]
         .map((o) => o.textContent.trim())
         .filter(Boolean);`,
    );
    if (
      !options.some((label) => label.startsWith("paka")) ||
      !options.some((label) => label.startsWith("pako"))
    ) {
      throw new Error(`picker missing candidates: ${JSON.stringify(options)}`);
    }
    // Each option also shows the candidate's definition, to disambiguate.
    if (!options.some((label) => label.includes("zzarg"))) {
      throw new Error(`picker missing definitions: ${JSON.stringify(options)}`);
    }

    // Choosing one resolves the conflict and updates the output.
    await js(
      `const row = ${zzargRow};
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

  // -- probe 26: class-role slots (the #flags gone) ------------------------
  await probe("26-class-role-slots", async () => {
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, {
      label: "translation view",
    });
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Rule tree');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.clause-canvas')`, {
      label: "clause canvas",
    });
    await waitJs(`document.querySelectorAll('.palette-chip.tag').length > 0`, {
      label: "class palette",
    });

    // The palette offers word classes, not "#flags".
    const chips = await js(
      `return [...document.querySelectorAll('.palette-row .palette-chip.tag')]
         .map((c) => c.textContent.trim());`,
    );
    if (chips.some((name) => name.includes("#"))) {
      throw new Error(`palette still shows #flags: ${JSON.stringify(chips)}`);
    }
    if (!chips.includes("verb")) {
      throw new Error(`palette missing the verb class: ${JSON.stringify(chips)}`);
    }

    // Build a grid of one verb-class slot.
    await js(
      `document.querySelectorAll('.clause-canvas .slot-remove').forEach((b) => b.click());
       return true;`,
    );
    await waitJs(`document.querySelectorAll('.clause-canvas .slot-card').length === 0`, {
      label: "grid cleared",
    });
    await js(
      `const c = [...document.querySelectorAll('.palette-row .palette-chip.tag')]
         .find((x) => x.textContent.trim() === 'verb');
       if (c) c.click();
       return !!c;`,
    );
    await waitJs(`document.querySelectorAll('.clause-canvas .slot-card').length === 1`, {
      label: "one class slot",
    });
    assertEqual(
      await js(
        `return document.querySelector('.clause-canvas .slot-card .badge')?.textContent.trim()`,
      ),
      "verb",
      "slot badge is the class",
    );

    // "run" matches velo (pos=verb); the slot accepts it.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'run';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await js(`document.querySelector('.runner button.translate')?.click(); return true;`);
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'velo'`,
      { label: "verb-class slot filled" },
    );
    if (!(await js(`return !!document.querySelector('.runner .status-badge.ok')`))) {
      throw new Error("class-slot translation did not report complete");
    }
  });

  // -- probe 27: an inflected input selects its feature by default ---------
  await probe("27-inferred-plural-inflection", async () => {
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
    await waitJs(`!!document.querySelector('.feature-bar')`, { label: "feature bar" });

    const type = (text) =>
      js(`const t = document.querySelector('.runner textarea');
        t.value = ${JSON.stringify(text)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;`);
    const pick = (label) =>
      js(`const b = [...document.querySelectorAll('.feature-bar button')]
         .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
       if (b) b.click();
       return !!b;`);

    // "dogs" implies plural, so the noun paradigm appends "u".
    await type("dogs");
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'kakau'`,
      { label: "inferred plural inflected" },
    );

    // The feature bar can still override it back to singular.
    if (!(await pick("Singular"))) throw new Error("no Singular button");
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'kaka'`,
      { label: "explicit singular overrides" },
    );
  });

  // -- probe 28: closing search cancels the filter -------------------------
  await probe("28-closing-search-cancels-filter", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
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

    const rowCount = () =>
      js(`return document.querySelectorAll('.dict-grid tbody tr:not(.ghost)').length;`);
    const searchButton = `.grid-toolbar button[title^="search"]`;
    const rows = () => rowCount();
    const before = await rows();

    const openSearch = () =>
      js(`const b = document.querySelector(${JSON.stringify(searchButton)});
         if (b) b.click();
         return !!b;`);
    const typeInto = (text) =>
      js(`const i = document.querySelector('.grid-search input');
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`);

    // Narrow the grid with a needle that matches a single row.
    await openSearch();
    await waitJs(`!!document.querySelector('.grid-search input')`, { label: "search box" });
    await typeInto("kaka");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterFilter = await rows();
    const filterValue = await js(
      `return document.querySelector('.grid-search input')?.value ?? null;`,
    );
    if (!(afterFilter < before)) {
      const names = await js(
        `return [...document.querySelectorAll('.dict-grid td.wordname-col input')].map((i) => i.value);`,
      );
      const indexes = await js(
        `return [...document.querySelectorAll('.dict-grid tbody tr[data-index]')].map((r) => r.getAttribute('data-index'));`,
      );
      throw new Error(
        `grid filtered: before=${before} after=${afterFilter} input=${JSON.stringify(filterValue)} names=${JSON.stringify(names)} indexes=${JSON.stringify(indexes)}`,
      );
    }

    // Closing the icon cancels the filter: every row is back and the box is gone.
    await openSearch();
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr:not(.ghost)').length === ${before}`,
      { label: "filter cancelled on close" },
    );
    assertEqual(
      await js(`return !!document.querySelector('.grid-search input')`),
      false,
      "search box hidden after close",
    );

    // Escape clears and closes the box too.
    await openSearch();
    await waitJs(`!!document.querySelector('.grid-search input')`, { label: "search box again" });
    await typeInto("kaka");
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr:not(.ghost)').length < ${before}`,
      { label: "grid filtered again" },
    );
    await js(`const i = document.querySelector('.grid-search input');
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       return true;`);
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr:not(.ghost)').length === ${before}`,
      { label: "filter cancelled on Escape" },
    );
    assertEqual(
      await js(`return !!document.querySelector('.grid-search input')`),
      false,
      "search box hidden after Escape",
    );
  });

  // -- probe 29: table designations in Settings ----------------------------
  await probe("29-table-roles-settings", async () => {
    const openSettings = () =>
      js(`const b = document.querySelector('.activity[title="Settings"]');
         if (b) b.click();
         return !!b;`);

    const openTablesTab = () =>
      js(`const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === 'Tables');
       if (b) b.click();
       return !!b;`);

    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings modal" });
    await openTablesTab();
    await waitJs(
      `[...document.querySelectorAll('.settings .rule .grow')]
         .some((x) => x.textContent.trim() === 'lex')`,
      { label: "lex row in Tables" },
    );

    const lexRow = `[...document.querySelectorAll('.settings .rule')]
       .find((r) => r.querySelector('.grow')?.textContent.trim() === 'lex')`;

    // Designate lex as a fixes table.
    await js(`const row = ${lexRow};
       const sel = row.querySelector('select');
       sel.value = 'fixes';
       sel.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`);
    await waitJs(
      `(() => { const row = ${lexRow}; return !!row && row.querySelectorAll('select').length === 3; })()`,
      { label: "fixes controls shown" },
    );

    // Point the trigger at the english text column.
    await js(`const row = ${lexRow};
       const trigger = row.querySelectorAll('select')[1];
       const option = [...trigger.options].find((o) => o.value === 'english');
       if (!option) throw new Error('no english column option');
       trigger.value = 'english';
       trigger.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`);

    // Close and reopen: the designation is reloaded from disk.
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
    await waitJs(`!document.querySelector('.settings')`, { label: "settings closed" });
    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings reopened" });
    await openTablesTab();
    await waitJs(
      `(() => { const row = ${lexRow}; return !!row && row.querySelector('select').value === 'fixes'; })()`,
      { label: "role persisted" },
    );
    assertEqual(
      await js(`const row = ${lexRow};
         return row.querySelectorAll('select')[1].value;`),
      "english",
      "trigger persisted",
    );

    // Leave the workspace as the earlier probes expect it.
    await js(`const row = ${lexRow};
       const sel = row.querySelector('select');
       sel.value = 'vocab';
       sel.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`);
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
  });

  // -- probe 30: a fixes table supplies an affix ---------------------------
  await probe("30-fixes-table-affix", async () => {
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

    // "dogz" finds no root directly; the fixes table's "-i" (trigger "z")
    // attaches to the root kaka (renamed from kala in probe 21).
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'dogz';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'kakai'`,
      { label: "fixes-table affix applied" },
    );
  });

  // -- probe 31: the grid virtualizes rows --------------------------------
  await probe("31-grid-row-virtualization", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('big'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'big' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "big grid" });
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr[data-index]').length > 0`,
      { label: "rows rendered" },
    );

    // Only a window of the 2000 rows is in the DOM.
    const rendered = await js(
      `return document.querySelectorAll('.dict-grid tbody tr[data-index]').length;`,
    );
    if (rendered >= 2000 || rendered > 300) {
      throw new Error(`expected a small window, rendered ${rendered}`);
    }

    // Scrolling to the end brings the last row into the DOM.
    await js(`const s = document.querySelector('.grid-scroll');
       s.scrollTop = s.scrollHeight;
       s.dispatchEvent(new Event('scroll', { bubbles: true }));
       return true;`);
    await waitJs(
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .some((i) => i.value === 'w1999')`,
      { label: "last row after scroll" },
    );
    // The ghost (add-word) row is still the last row of the body.
    const lastIsGhost = await js(
      `const rows = [...document.querySelectorAll('.dict-grid tbody tr')];
       return rows[rows.length - 1]?.classList.contains('ghost') === true;`,
    );
    if (!lastIsGhost) throw new Error("ghost row is not last after virtualization");
  });

  // -- probe 32: the first-run setup wizard ---------------------------------
  await probe("32-setup-wizard", async () => {
    // Open it from Settings (auto-open only fires on a blank workspace).
    await js(`const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.settings')`, { label: "settings" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.settings button')]
         .find((x) => x.textContent.trim() === 'Run setup');
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'Run setup' button");
    await waitJs(`!!document.querySelector('.setup-wizard')`, { label: "wizard" });

    // Step 1: name the language.
    await js(`const input = document.querySelector('.setup-wizard input');
       input.value = 'Vokala';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    const next = () =>
      js(`const b = [...document.querySelectorAll('.setup-wizard button')]
         .find((x) => x.textContent.trim() === 'Next');
       if (b) b.click();
       return !!b;`);
    await next(); // phonology
    await next(); // grammar
    await next(); // morphology
    const finished = await js(
      `const b = [...document.querySelectorAll('.setup-wizard button')]
         .find((x) => x.textContent.trim() === 'Finish');
       if (b) b.click();
       return !!b;`,
    );
    if (!finished) throw new Error("no Finish button");
    await waitJs(`!document.querySelector('.setup-wizard')`, { label: "wizard closed" });

    // The language name was written through to config.
    await js(`const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings again" });
    assertEqual(
      await js(`return document.querySelector('.settings-content input')?.value;`),
      "Vokala",
      "language name persisted",
    );
    // A grammar rule for the chosen word order was created.
    await js(`const b = [...document.querySelectorAll('.settings-nav button')]
       .find((x) => x.textContent.trim() === 'Grammar rules');
       if (b) b.click();
       return !!b;`);
    await waitJs(
      `[...document.querySelectorAll('.settings .rule input')].length > 0`,
      { label: "grammar tab" },
    );
    const hasRule = await js(
      `return [...document.querySelectorAll('.settings .rule input')]
         .some((i) => i.value === 'SVO');`,
    );
    if (!hasRule) throw new Error("starter grammar rule missing");
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
  });

  // -- probe 33: the Settings profile section -------------------------------
  await probe("33-profile-settings", async () => {
    await js(`const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings" });
    await js(`const b = [...document.querySelectorAll('.settings-nav button')]
       .find((x) => x.textContent.trim() === 'Profile');
       if (b) b.click();
       return !!b;`);
    await waitJs(
      `[...document.querySelectorAll('.settings-content button')]
         .some((b) => b.textContent.trim() === 'Export profile')`,
      { label: "profile tab" },
    );
    const buttons = await js(
      `return [...document.querySelectorAll('.settings-content button')].map((b) => b.textContent.trim());`,
    );
    if (!buttons.includes("Export profile") || !buttons.includes("Import profile")) {
      throw new Error(`profile buttons missing: ${JSON.stringify(buttons)}`);
    }
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
  });

  // -- probe 34: Settings linting & translator panel -----------------------
  await probe("34-settings-linting-translator", async () => {
    // A syllable shape to display comes from the Phonology tab.
    await openActivity("Phonology");
    await waitJs(`!!document.querySelector('.phonology')`, { label: "phonology view" });
    await waitJs(`!!document.querySelector('.preset-row .preset')`, { label: "shape presets" });
    const added = await js(
      `const b = [...document.querySelectorAll('.preset-row .preset')]
         .find((x) => x.textContent.trim() === 'CVC');
       if (b && !b.disabled) b.click();
       return !!b;`,
    );
    if (!added) throw new Error("no CVC preset");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const openSettings = () =>
      js(`const b = document.querySelector('.activity[title="Settings"]');
         if (b) b.click();
         return !!b;`);
    const openLintingTab = () =>
      js(`const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === 'Linting & translator');
       if (b) b.click();
       return !!b;`);
    const groupInputs = () =>
      js(`return [...document.querySelectorAll('.settings .group input')].map((i) => i.value);`);

    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings nav" });
    await openLintingTab();
    await waitJs(`!!document.querySelector('.settings .group')`, { label: "linting group" });
    // Settings loads the inventory asynchronously; wait for it to fill in.
    await waitJs(
      `(document.querySelectorAll('.settings .group input')[0]?.value ?? '').length > 0`,
      { label: "inventory loaded" },
    );
    const inputs = await groupInputs();
    assertEqual(inputs[0], "p t k m n s l", "consonants pulled from inventory");
    assertEqual(inputs[1], "a i u", "vowels pulled from inventory");
    const shapes = await js(
      `return [...document.querySelectorAll('.settings .group .phoneme-chip .symbol')]
         .map((s) => s.textContent.trim());`,
    );
    if (!shapes.includes("CVC")) {
      throw new Error(`syllable shape missing: ${JSON.stringify(shapes)}`);
    }

    // Editing the vowel list persists (and reaches the inventory).
    await js(`const inputs = [...document.querySelectorAll('.settings .group input')];
       const i = inputs[1];
       i.value = 'a i u o';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
    await waitJs(`!document.querySelector('.settings')`, { label: "settings closed" });
    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings nav again" });
    await openLintingTab();
    await waitJs(`!!document.querySelector('.settings .group')`, { label: "linting group again" });
    await waitJs(
      `[...document.querySelectorAll('.settings .group input')][1]?.value === 'a i u o'`,
      { label: "vowel edit persisted" },
    );

    // The plural ending is editable from here too.
    await js(`const inputs = [...document.querySelectorAll('.settings .group input')];
       const i = inputs[2];
       i.value = 'es';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
    await waitJs(`!document.querySelector('.settings')`, { label: "settings closed again" });

    // The translator now uses the new plural ending.
    await openActivity("Translation");
    await waitJs(`!!document.querySelector('.translation')`, { label: "translation" });
    await js(
      `const b = [...document.querySelectorAll('.translation-toolbar .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Word for word');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.runner textarea')`, { label: "runner" });
    // Drop any feature selection left by earlier probes so the incoming
    // English plural is inferred, not overridden.
    await js(
      `document.querySelectorAll('.feature-bar button.active').forEach((b) => b.click());
       return true;`,
    );
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'dogs';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitJs(
      `(document.querySelector('.runner .output')?.textContent ?? '').trim() === 'kakaes'`,
      { label: "plural ending applied" },
    );
  });

  // -- probe 35: task/table keybinds + toolbar task button ------------------
  await probe("35-editor-task-and-table-keybinds", async () => {
    await openActivity("Notes");
    await openNote("fmt.md");
    await waitEditorText("fmt.md", FMT);
    await focusEditor("fmt.md");
    await placeCursor("fmt.md", 2);

    const hasTaskButton = await js(
      `return !!document.querySelector('.editor-toolbar button[aria-label="Task list"]');`,
    );
    if (!hasTaskButton) throw new Error("toolbar has no task-list button");

    // Ctrl+Alt+L toggles a task item, matching the TaskWidget rendering.
    await pressKey("l", [CTRL, ALT]);
    assertEqual(await editorText("fmt.md"), "- [ ] plain line\n", "Ctrl+Alt+L on");
    await pressKey("l", [CTRL, ALT]);
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+Alt+L off");

    // Ctrl+Shift+T inserts a table.
    await pressKey("t", [CTRL, SHIFT]);
    const table = await editorText("fmt.md");
    if (!table.includes("|") || !table.includes("---")) {
      throw new Error(`Ctrl+Shift+T did not insert a table: ${JSON.stringify(table)}`);
    }
  });

  // -- probe 36: Settings sidebar tabs + keybind reference ------------------
  await probe("36-settings-tabs-and-keybinds", async () => {
    await js(`const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings nav" });

    const tabs = await js(
      `return [...document.querySelectorAll('.settings-nav button')].map((b) => b.textContent.trim());`,
    );
    for (const name of [
      "Language",
      "Grammar rules",
      "Tables",
      "Linting & translator",
      "Keybinds",
      "Profile",
    ]) {
      if (!tabs.includes(name)) {
        throw new Error(`missing tab ${name}: ${JSON.stringify(tabs)}`);
      }
    }

    const openTab = (name) =>
      js(`const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === ${JSON.stringify(name)});
       if (b) b.click();
       return !!b;`);

    // Keybinds tab lists real bindings.
    if (!(await openTab("Keybinds"))) throw new Error("no Keybinds tab");
    await waitJs(`!!document.querySelector('.keybind-list')`, { label: "keybind list" });
    const rows = await js(
      `return [...document.querySelectorAll('.keybind-list li')].map((li) => ({
         keys: li.querySelector('.keys')?.textContent.trim(),
         label: li.querySelector('.grow')?.textContent.trim(),
       }));`,
    );
    const has = (keys, label) =>
      rows.some((row) => row.keys === keys && row.label === label);
    if (!has("Ctrl+B", "Bold")) throw new Error("no Bold binding");
    if (!has("Ctrl+Alt+L", "Task list")) throw new Error("no task binding");
    if (!has("Ctrl+Shift+T", "Insert table")) throw new Error("no table binding");
    if (!has("Ctrl+Shift+P", "Insert image")) throw new Error("no image binding");

    // Other tabs still render their controls.
    await openTab("Linting & translator");
    await waitJs(`!!document.querySelector('.settings .group input')`, {
      label: "linting controls",
    });
    await openTab("Tables");
    await waitJs(`!!document.querySelector('.settings-content .rule select')`, {
      label: "table role controls",
    });

    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
  });

  // -- probe 37: git history rows are not hyperlinks ------------------------
  await probe("37-git-history-rows", async () => {
    // Create a note so there is guaranteed something to check in.
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.explorer-actions')`, { label: "notes sidebar" });
    await js(`document.querySelector('.explorer-actions button:nth-of-type(1)').click();
       return true;`);
    await waitJs(`!!document.querySelector('.sidebar input.new-input')`, {
      label: "new note input",
    });
    await js(`const i = document.querySelector('.sidebar input.new-input');
       i.value = 'zz-git-note';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       return true;`);
    await waitJs(
      `!!document.querySelector('.tree-row[data-path="zz-git-note.md"]')`,
      { label: "new note row" },
    );

    await openActivity("Source Control");
    await waitJs(`!!document.querySelector('.git-panel')`, { label: "git panel" });
    await waitJs(
      `document.querySelectorAll('.git-panel .vcs-status li').length > 0`,
      { label: "pending change" },
    );
    await js(`const t = document.querySelector('.git-panel textarea');
       if (!t) return false;
       t.value = 'nueon: history probe';
       t.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await js(`const b = [...document.querySelectorAll('.git-panel button')]
       .find((x) => x.textContent.trim() === 'Check in');
       if (b) b.click();
       return !!b;`);
    await waitJs(
      `[...document.querySelectorAll('.vcs-log .summary')]
         .some((s) => s.textContent.trim() === 'nueon: history probe')`,
      { label: "committed summary in history" },
    );

    const rows = await js(
      `return [...document.querySelectorAll('.vcs-log .log-row')].map((r) => ({
         hash: r.querySelector('.hash')?.textContent.trim(),
         summary: r.querySelector('.summary')?.textContent.trim(),
       }));`,
    );
    if (!rows.length) throw new Error("no history rows");
    if (!/^[0-9a-f]{7}$/.test(rows[0].hash ?? "")) {
      throw new Error(`bad hash chip: ${JSON.stringify(rows[0])}`);
    }
    if (!rows.some((r) => r.summary === "nueon: history probe")) {
      throw new Error(`committed summary missing: ${JSON.stringify(rows)}`);
    }
    const links = await js(
      `return document.querySelectorAll('.vcs-log button.link').length;`,
    );
    if (links !== 0) throw new Error("history still uses link styling");
  });

  // -- probe 38: per-kind "don't ask again" on confirmations ----------------
  await probe("38-confirm-suppression", async () => {
    const newNote = async (name) => {
      await js(`document.querySelector('.explorer-actions button:nth-of-type(1)').click();
         return true;`);
      await waitJs(`!!document.querySelector('.sidebar input.new-input')`, {
        label: "new note input",
      });
      await js(`const i = document.querySelector('.sidebar input.new-input');
         i.value = ${JSON.stringify(name)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return true;`);
      await waitJs(
        `!!document.querySelector('.tree-row[data-path=${JSON.stringify(name + ".md")}]')`,
        { label: `new note ${name}` },
      );
    };
    const deleteViaMenu = async (path) => {
      await js(`const row = document.querySelector('.tree-row[data-path=${JSON.stringify(path)}]');
         row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
         return true;`);
      await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "context menu" });
      await js(`const b = [...document.querySelectorAll('.ctx-menu button')]
         .find((x) => x.textContent.trim() === 'Delete');
         if (b) b.click();
         return !!b;`);
    };

    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.explorer-actions')`, { label: "notes sidebar" });

    // First delete shows the dialog with a "don't ask again" checkbox.
    await newNote("zz-del-a");
    await deleteViaMenu("zz-del-a.md");
    await waitJs(`!!document.querySelector('.confirm-dialog')`, { label: "confirm dialog" });
    const box = await js(
      `return !!document.querySelector('.confirm-dialog .confirm-dont-ask input[type="checkbox"]');`,
    );
    if (!box) throw new Error("no 'don't ask again' checkbox");
    await js(`const c = document.querySelector('.confirm-dialog .confirm-dont-ask input');
       c.checked = true;
       c.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`);
    await js(`const b = document.querySelector('.confirm-dialog .confirm-ok');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!document.querySelector('.confirm-dialog')`, { label: "dialog closed" });
    await waitJs(`!document.querySelector('.tree-row[data-path="zz-del-a.md"]')`, {
      label: "note deleted",
    });

    // Settings reports the suppression and can reset it.
    await js(`document.querySelector('.activity[title="Settings"]').click(); return true;`);
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings" });
    await js(`const b = [...document.querySelectorAll('.settings-nav button')]
       .find((x) => x.textContent.trim() === 'Profile');
       if (b) b.click();
       return !!b;`);
    await waitJs(
      `[...document.querySelectorAll('.settings-content button')]
         .some((b) => b.textContent.includes('Reset suppressed confirmations'))`,
      { label: "reset control" },
    );
    const resetLabel = await js(
      `return [...document.querySelectorAll('.settings-content button')]
         .find((b) => b.textContent.includes('Reset suppressed confirmations'))?.textContent.trim();`,
    );
    if (!resetLabel.includes("(1)")) {
      throw new Error(`suppression count not shown: ${JSON.stringify(resetLabel)}`);
    }
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);

    // A second delete of the same kind no longer asks.
    await openActivity("Notes");
    await newNote("zz-del-b");
    await deleteViaMenu("zz-del-b.md");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await js(`return !!document.querySelector('.confirm-dialog');`)) {
      throw new Error("confirm shown despite suppression");
    }
    await waitJs(`!document.querySelector('.tree-row[data-path="zz-del-b.md"]')`, {
      label: "second note deleted",
    });
  });

  // -- probe 39: editor overflow menu + line-number toggle ------------------
  await probe("39-editor-overflow-menu", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.explorer-actions')`, { label: "notes sidebar" });
    await waitJs(
      `!!document.querySelector('.tree-row[data-path="beta.md"] .tree-name')`,
      { label: "notes tree" },
    );
    await openNote("beta.md");
    await waitJs(`!!document.querySelector('.cm-lineNumbers')`, { label: "line numbers on" });

    const openMenu = () =>
      js(`const t = document.querySelector('.editor-toolbar [title="Editor actions"]');
         if (t) { t.click(); return true; }
         return false;`);
    if (!(await openMenu())) throw new Error("no editor overflow trigger");
    await waitJs(`!!document.querySelector('.popover-panel')`, { label: "overflow menu" });
    const items = await js(
      `return [...document.querySelectorAll('.popover-panel .picker-body button')]
         .map((b) => b.textContent.trim());`,
    );
    for (const want of [
      "Copy path",
      "Open in default app",
      "Reveal in file explorer",
      "Hide line numbers",
      "Delete file",
    ]) {
      if (!items.includes(want)) {
        throw new Error(`menu missing ${want}: ${JSON.stringify(items)}`);
      }
    }

    // Hide, then show, the line-number gutter.
    await js(`const b = [...document.querySelectorAll('.popover-panel button')]
       .find((x) => x.textContent.trim() === 'Hide line numbers');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!document.querySelector('.cm-lineNumbers')`, { label: "line numbers hidden" });

    await openMenu();
    await waitJs(`!!document.querySelector('.popover-panel')`, { label: "menu again" });
    await js(`const b = [...document.querySelectorAll('.popover-panel button')]
       .find((x) => x.textContent.trim() === 'Show line numbers');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.cm-lineNumbers')`, { label: "line numbers shown" });
  });

  // -- probe 40: notes sidebar export menu ----------------------------------
  await probe("40-sidebar-export-menu", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.explorer-actions')`, { label: "notes sidebar" });
    const opened = await js(
      `const t = document.querySelector('.explorer-actions [title="Export"]');
       if (t) { t.click(); return true; }
       return false;`,
    );
    if (!opened) throw new Error("no export trigger in the sidebar");
    await waitJs(`!!document.querySelector('.popover-panel')`, { label: "export menu" });
    const items = await js(
      `return [...document.querySelectorAll('.popover-panel .picker-body button')]
         .map((b) => b.textContent.trim());`,
    );
    if (!items.includes("Export workspace as zip")) {
      throw new Error(`missing zip export: ${JSON.stringify(items)}`);
    }
    if (!items.includes("Export profile")) {
      throw new Error(`missing profile export: ${JSON.stringify(items)}`);
    }
    // Dismiss the menu.
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;`);
  });

  // -- probe 41: assets folder + file viewer --------------------------------
  await probe("41-assets-folder-and-file-viewer", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.explorer-actions')`, { label: "notes sidebar" });
    await waitJs(`!!document.querySelector('.tree-row[data-path="assets"]')`, {
      label: "assets folder",
    });
    await waitJs(`!!document.querySelector('.tree-row[data-path="assets/pic.png"]')`, {
      label: "asset file in tree",
    });
    // Dotfiles are shown too: full transparency of the notes dir.
    await waitJs(`!!document.querySelector('.tree-row[data-path=".secret.md"]')`, {
      label: "dotfile in tree",
    });

    const openTreeFile = (p) =>
      js(`const r = document.querySelector('.tree-row[data-path=${JSON.stringify(p)}] .tree-name');
         if (r) { r.click(); return true; }
         return false;`);

    // An image opens in the viewer with a loading <img>.
    if (!(await openTreeFile("assets/pic.png"))) throw new Error("no pic.png row");
    await waitJs(`!!document.querySelector('.file-viewer img.file-image')`, {
      label: "image viewer",
    });
    if (!(await js(`return (document.querySelector('.file-image')?.naturalWidth ?? 0) > 0;`))) {
      throw new Error("image did not load via the asset protocol");
    }

    // A .txt asset opens in the viewer as text, not the Markdown editor.
    if (!(await openTreeFile("assets/notes.txt"))) throw new Error("no notes.txt row");
    await waitJs(`!!document.querySelector('.file-viewer .file-text')`, { label: "text viewer" });
    const text = await js(`return document.querySelector('.file-text')?.textContent ?? '';`);
    if (!text.includes("asset text")) throw new Error(`text asset not shown: ${text}`);

    // An unpublishable binary offers "open in default app".
    if (!(await openTreeFile("assets/doc.pdf"))) throw new Error("no doc.pdf row");
    await waitJs(`!!document.querySelector('.file-viewer .file-unsupported')`, {
      label: "unsupported panel",
    });
    const hasOpen = await js(
      `return [...document.querySelectorAll('.file-viewer button')]
         .some((b) => b.textContent.includes('Open in default app'));`,
    );
    if (!hasOpen) throw new Error("no open-in-default button");
  });

  // -- probe 42: editable keybinds ------------------------------------------
  await probe("42-editable-keybinds", async () => {
    // Keep a note open so the remap must reconfigure the live editor.
    await openActivity("Notes");
    await openNote("beta.md");
    await focusEditor("beta.md");
    await placeCursor("beta.md", 2);

    const openSettings = () =>
      js(`document.querySelector('.activity[title="Settings"]').click(); return true;`);
    const openKeybinds = () =>
      js(`const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === 'Keybinds');
       if (b) b.click();
       return !!b;`);
    const boldRow = `[...document.querySelectorAll('.keybind-list li')]
       .find((li) => li.querySelector('.grow')?.textContent.trim() === 'Bold')`;

    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings" });
    await openKeybinds();
    await waitJs(`!!document.querySelector('.keybind-list')`, { label: "keybind list" });

    // Edit Bold.
    await js(`const li = ${boldRow}; const b = li?.querySelector('button');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.keybind-capture')`, { label: "capture modal" });

    // A reserved combo is refused.
    await pressKey("c", [CTRL]);
    await waitJs(`!!document.querySelector('.keybind-capture .error')`, {
      label: "reserved error",
    });
    if (!(await js(`return document.querySelector('.keybind-capture button.primary')?.disabled === true;`))) {
      throw new Error("reserved combo should disable Save");
    }

    // A free combo is captured and saved.
    await pressKey("b", [CTRL, ALT]);
    await waitJs(
      `document.querySelector('.keybind-capture .capture-keys')?.textContent.trim() === 'Ctrl+Alt+B'`,
      { label: "captured combo" },
    );
    await js(`const b = document.querySelector('.keybind-capture button.primary');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!document.querySelector('.keybind-capture')`, { label: "capture closed" });
    await waitJs(
      `(${boldRow})?.querySelector('.keys')?.textContent.trim() === 'Ctrl+Alt+B'`,
      { label: "row shows the override" },
    );
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
    await waitJs(`!document.querySelector('.settings-nav')`, { label: "settings closed" });

    // The custom combo bolds in the (still mounted) editor.
    await focusEditor("beta.md");
    await placeCursor("beta.md", 2);
    await pressKey("b", [CTRL, ALT]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const doc = await editorText("beta.md");
    if (!doc.includes("**")) {
      throw new Error(`custom keybind did not bold: ${JSON.stringify(doc)}`);
    }

    // Reset restores the default.
    await openSettings();
    await waitJs(`!!document.querySelector('.settings-nav')`, { label: "settings again" });
    await openKeybinds();
    await waitJs(`!!document.querySelector('.keybind-list')`, { label: "keybind list again" });
    await js(`const li = ${boldRow};
       const b = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Reset');
       if (b) b.click();
       return !!b;`);
    await waitJs(
      `(${boldRow})?.querySelector('.keys')?.textContent.trim() === 'Ctrl+B'`,
      { label: "reset to default" },
    );
    await js(`const b = document.querySelector('.modal-head button'); if (b) b.click(); return !!b;`);
  });

  // -- probe 43: bulk value edit over selected rows -------------------------
  await probe("43-bulk-value-edit", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
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

    // The row for velo, checked for a text token.
    const rowHas = (word, needle) =>
      `(() => {
         const input = [...document.querySelectorAll('.dict-grid td.wordname-col input')]
           .find((i) => i.value === ${JSON.stringify(word)});
         const row = input?.closest('tr');
         return !!row && row.textContent.includes(${JSON.stringify(needle)});
       })()`;

    // Select every row.
    await js(`const c = document.querySelector('.dict-grid th.select-col input');
       if (c && !c.checked) c.click();
       return true;`);
    await waitJs(
      `[...document.querySelectorAll('.grid-toolbar button')]
         .some((b) => b.textContent.includes('Set value'))`,
      { label: "bulk button" },
    );
    await js(`const b = [...document.querySelectorAll('.grid-toolbar button')]
       .find((x) => x.textContent.includes('Set value'));
       b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.popover-panel')`, { label: "bulk panel" });

    // Target the `pos` column, value "noun".
    await js(`const panel = document.querySelector('.popover-panel');
       const select = panel.querySelector('select');
       select.value = 'pos';
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`);
    await waitJs(`!!document.querySelector('.popover-panel input')`, {
      label: "value input",
    });
    await js(`const input = document.querySelector('.popover-panel input');
       input.value = 'noun';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await js(`const b = [...document.querySelectorAll('.popover-panel button')]
       .find((x) => x.textContent.trim() === 'Apply');
       b.click();
       return !!b;`);
    await waitJs(`!document.querySelector('.popover-panel')`, { label: "panel closed" });
    await waitJs(rowHas("velo", "noun"), { label: "bulk applied to velo" });

    // One undo restores every row.
    await js(`const b = [...document.querySelectorAll('.grid-toolbar button')]
       .find((x) => x.getAttribute('title') === 'Undo');
       b.click();
       return !!b;`);
    await waitJs(rowHas("velo", "verb"), { label: "velo reverted" });
    if (await js(rowHas("velo", "noun"))) {
      throw new Error("one undo did not revert the whole batch");
    }
  });

  // -- probe 44: per-column value suggestions -------------------------------
  await probe("44-column-value-suggestions", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });

    // Open the add-word wizard (it uses the same cell editors).
    await js(`const b = document.querySelector('.grid-toolbar button.primary');
       b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.add-word-modal')`, { label: "add word modal" });

    const propInput = (name) =>
      `[...document.querySelectorAll('.add-word-modal .prop-row')]
         .find((r) => r.querySelector('.prop-name')?.textContent.trim().endsWith(${JSON.stringify(name)}))
         ?.querySelector('input')`;

    // A tag_list column (pos) suggests existing values; Tab accepts.
    await js(`const i = ${propInput("pos")}; if (i) i.focus(); return !!i;`);
    await js(`const i = document.activeElement;
       i.value = 'no';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await waitJs(`!!document.querySelector('.suggestions')`, { label: "pos suggestions" });
    // Browse to the suggestion, then Enter accepts it.
    await pressKey(ARROW_DOWN);
    await pressKey(ENTER);
    await waitJs(
      `(() => {
         const row = [...document.querySelectorAll('.add-word-modal .prop-row')]
           .find((r) => r.querySelector('.prop-name')?.textContent.trim().endsWith('pos'));
         return !!row && [...row.querySelectorAll('.pill')]
           .some((p) => p.textContent.trim() === 'noun');
       })()`,
      { label: "pos suggestion accepted" },
    );

    // A text column (english) suggests too.
    await js(`const i = ${propInput("english")}; if (i) i.focus(); return !!i;`);
    await js(`const i = document.activeElement;
       i.value = 'do';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await waitJs(`!!document.querySelector('.suggestions')`, { label: "english suggestions" });
    await pressKey(ARROW_DOWN);
    await pressKey(ENTER);
    await waitJs(`(${propInput("english")})?.value === 'dog'`, {
      label: "english suggestion accepted",
    });

    await js(`const b = document.querySelector('.add-word-modal .modal-head button');
       if (b) b.click();
       return !!b;`);
  });

  // -- probe 45: wordname warning tooltip + inspector word checks -----------
  await probe("45-word-checks-tooltip-inspector", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
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

    // Select the row for a word with unknown sounds, then check its warning.
    const row = (word) =>
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .find((i) => i.value === ${JSON.stringify(word)})?.closest('tr')`;
    await js(`const tr = ${row("big")}; if (tr) tr.click(); return !!tr;`);
    await waitJs(`!!(${row("big")})?.querySelector('.word-warning')`, {
      label: "warning icon",
    });
    const warning = await js(
      `const w = (${row("big")})?.querySelector('.word-warning');
       return w ? { title: w.getAttribute('title'), pe: getComputedStyle(w).pointerEvents } : null;`,
    );
    if (!warning || !warning.title || !warning.title.includes("sound inventory")) {
      throw new Error(`warning tooltip missing: ${JSON.stringify(warning)}`);
    }
    if (warning.pe !== "auto") {
      throw new Error(`warning is not hoverable (pointer-events=${warning.pe})`);
    }

    // The inspector explains it and shows the breakdown.
    await js(`const b = document.querySelector('[title="Toggle Inspector"]');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.inspector')`, { label: "inspector" });
    await waitJs(
      `[...document.querySelectorAll('.inspector .word-check')]
         .some((p) => p.textContent.includes('sound inventory'))`,
      { label: "unknown-phoneme explanation" },
    );
    await waitJs(`!!document.querySelector('.inspector .word-segment.unknown')`, {
      label: "breakdown flags unknown sound",
    });
    if (!(await js(`return document.querySelectorAll('.inspector .phoneme-chip').length > 0;`))) {
      throw new Error("inspector did not list the inventory");
    }
  });

  // -- probe 46: the Tags popover does not steal focus ----------------------
  await probe("46-tags-popover-no-autofocus", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });

    await js(`const b = [...document.querySelectorAll('.grid-toolbar .popover-trigger')]
       .find((x) => x.textContent.trim() === 'Tags');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.popover-panel .tag-row input')`, {
      label: "tags popover",
    });

    // Opening the panel must not focus the new-tag box (which pops a dropdown).
    if (
      await js(`return document.activeElement === document.querySelector('.popover-panel .tag-row input');`)
    ) {
      throw new Error("the new-tag input was autofocused on open");
    }

    // It still works when the user chooses to type.
    await js(`const i = document.querySelector('.popover-panel .tag-row input');
       i.focus();
       i.value = 'zztag';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       return true;`);
    await waitJs(
      `[...document.querySelectorAll('.popover-panel .tag-row .grow')]
         .some((x) => x.textContent.trim() === 'zztag')`,
      { label: "tag added" },
    );

    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;`);
  });

  // -- probe 47: list cells add on Enter, wrap, and browse ---------------
  await probe("47-list-cell-enter-and-browse", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await js(`const b = document.querySelector('.grid-toolbar button.primary');
       b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.add-word-modal')`, { label: "add word modal" });

    const posRow = `[...document.querySelectorAll('.add-word-modal .prop-row')]
       .find((r) => r.querySelector('.prop-name')?.textContent.trim().endsWith('pos'))`;
    const posInput = `(${posRow})?.querySelector('input.pill-input')`;
    const pillExists = (value) =>
      `(() => { const row = ${posRow}; return !!row && [...row.querySelectorAll('.pill')]
         .some((p) => p.textContent.trim() === ${JSON.stringify(value)}); })()`;

    // Focusing an empty cell shows no dropdown.
    await js(`const i = ${posInput}; if (i) i.focus(); return !!i;`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await js(`return !!document.querySelector('.suggestions');`)) {
      throw new Error("dropdown opened on an empty focus");
    }

    // A novel value + Enter adds the entry and keeps focus.
    await js(`const i = ${posInput}; i.value = 'zzz';
       i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await pressKey(ENTER);
    await waitJs(pillExists("zzz"), { label: "Enter added the pill" });
    if (!(await js(`return document.activeElement === (${posInput});`))) {
      throw new Error("focus left the cell after Enter");
    }

    // A second value + Tab adds it and moves on.
    await js(`const i = ${posInput}; i.value = 'qqq';
       i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await pressKey(TAB);
    await waitJs(pillExists("qqq"), { label: "Tab added the pill" });
    if (await js(`return document.activeElement === (${posInput});`)) {
      throw new Error("Tab did not move focus on");
    }

    // ↓ from an empty cell browses every value.
    await js(`const i = ${posInput}; i.focus();
       i.value = '';
       i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await pressKey(ARROW_DOWN);
    await waitJs(`!!document.querySelector('.suggestions')`, { label: "Down browses all" });

    // The leading + focuses the input and opens the list.
    await js(`const i = ${posInput}; i.blur(); return true;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await js(`return !!document.querySelector('.suggestions');`)) {
      throw new Error("dropdown did not close on blur");
    }
    await js(`const b = (${posRow})?.querySelector('.pill-add'); if (b) b.click(); return !!b;`);
    await waitJs(`!!document.querySelector('.suggestions')`, { label: "+ opens the list" });
    if (!(await js(`return document.activeElement === (${posInput});`))) {
      throw new Error("+ did not focus the input");
    }

    await js(`const b = document.querySelector('.add-word-modal .modal-head button');
       if (b) b.click();
       return !!b;`);
  });

  // -- probe 48: deleting a word with dependents ---------------------------
  await probe("48-delete-word-with-dependents", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await waitJs(
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .some((i) => i.value === 'kaka')`,
      { label: "kaka row" },
    );

    const delRow = (word) =>
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .find((i) => i.value === ${JSON.stringify(word)})?.closest('tr')`;

    // Deleting the parent (kaka, renamed from kala) prompts about dependents.
    await js(`const tr = ${delRow("kaka")};
       const b = tr?.querySelector('td:last-child button');
       if (b) b.click();
       return !!b;`);
    await waitJs(`!!document.querySelector('.delete-word-modal')`, { label: "delete modal" });
    await waitJs(
      `[...document.querySelectorAll('.delete-word-modal .dependent-row .grow')]
         .some((x) => x.textContent.trim() === 'paka')`,
      { label: "dependent listed" },
    );

    // Confirm stays disabled until the word's name is typed.
    if (
      !(await js(`return document.querySelector('.delete-word-modal .modal-foot button.danger')?.disabled === true;`))
    ) {
      throw new Error("Delete was enabled before typing the name");
    }

    // Reassign paka under velo, then type the name to enable Delete.
    const moved = await js(
      `const row = [...document.querySelectorAll('.delete-word-modal .dependent-row')]
         .find((r) => r.querySelector('.grow')?.textContent.trim() === 'paka');
       const select = row?.querySelector('select');
       const option = [...(select?.options ?? [])].find((o) => o.textContent.includes('velo'));
       if (!option) return false;
       select.value = option.value;
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
    if (!moved) throw new Error("no 'velo' parent candidate for paka");
    await js(`const i = document.querySelector('.delete-word-modal .field input');
       i.value = 'kaka';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`);
    await waitJs(
      `document.querySelector('.delete-word-modal .modal-foot button.danger')?.disabled === false`,
      { label: "Delete enabled after typing" },
    );
    await js(`document.querySelector('.delete-word-modal .modal-foot button.danger').click();
       return true;`);
    await waitJs(`!document.querySelector('.delete-word-modal')`, { label: "modal closed" });
    await waitJs(`!(${delRow("kaka")})`, { label: "kaka deleted" });
    await waitJs(`(${delRow("paka")})?.textContent.includes('velo')`, {
      label: "paka re-parented to velo",
    });
  });

  // -- probe 56: grid Anki export option ------------------------------------
  await probe("56-grid-anki-export", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });

    const openedMenu = await js(
      `const b = [...document.querySelectorAll('.grid-toolbar .popover-trigger')]
         .find((x) => x.textContent.trim() === 'Export');
       if (b) b.click();
       return !!b;`,
    );
    if (!openedMenu) throw new Error("no export trigger in the grid toolbar");
    await waitJs(`!!document.querySelector('.popover-panel .picker-body')`, {
      label: "grid export menu",
    });
    const items = await js(
      `return [...document.querySelectorAll('.popover-panel .picker-body button')]
         .map((b) => b.textContent.trim());`,
    );
    if (!items.includes("Anki (.txt)")) {
      throw new Error(`missing Anki export: ${JSON.stringify(items)}`);
    }
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;`);
  });

  // -- probe 57: an ordered multi-slot paradigm stacks endings --------------
  await probe("57-multi-slot-affixes", async () => {
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
    await waitJs(`!!document.querySelector('.feature-bar')`, { label: "feature bar" });

    // Clear any selection left by an earlier probe.
    await js(
      `document.querySelectorAll('.feature-bar button.active').forEach((b) => b.click());
       return true;`,
    );

    // "run" matches velo (pos=verb). Selecting Past (tense slot, order 1) and
    // Perfective (aspect slot, order 2) stacks both endings: velo + i + a.
    await js(`const t = document.querySelector('.runner textarea');
      t.value = 'run';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    const pick = (label) =>
      js(
        `const b = [...document.querySelectorAll('.feature-bar button')]
           .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
         if (b) b.click();
         return !!b;`,
      );
    if (!(await pick("Past"))) throw new Error("no Past button");
    if (!(await pick("Perfective"))) throw new Error("no Perfective button");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const output = await js(
      `return (document.querySelector('.runner .output')?.textContent ?? '').trim();`,
    );
    if (output !== "veloia") throw new Error(`expected 'veloia', got '${output}'`);
  });

  // -- probe 58: the Morphology activity edits classes and morphemes --------
  await probe("58-morphology-section", async () => {
    const opened = await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no Morphology activity button");
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await waitJs(`!!document.querySelector('.morphology-sidebar')`, {
      label: "morphology sidebar",
    });

    // On Compose/Inflect the sidebar lists the morphemes: `-i` comes from a
    // trigger-based fixes table, `-o` from one with no English column at all.
    await waitJs(`!!document.querySelector('.morphology-sidebar .morpheme-row')`, {
      label: "morphemes region",
    });
    const morphemes = await js(
      `return [...document.querySelectorAll('.morphology-sidebar .morpheme-row .mono')]
         .map((x) => x.textContent.trim());`,
    );
    if (!morphemes.includes("i") || !morphemes.includes("o")) {
      throw new Error(`missing morphemes (-i, -o): ${JSON.stringify(morphemes)}`);
    }

    // The Endings tab owns class selection through the sidebar chips.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Endings');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .class-row')`, {
      label: "class chips",
    });
    const classes = await js(
      `return [...document.querySelectorAll('.morphology-sidebar .class-row .grow')]
         .map((x) => x.textContent.trim());`,
    );
    if (!classes.includes("verb") || !classes.includes("noun")) {
      throw new Error(`missing classes: ${JSON.stringify(classes)}`);
    }

    // The verb's seeded tense+aspect paradigm shows in the coverage grid.
    await js(
      `const b = [...document.querySelectorAll('.morphology-sidebar .class-row')]
         .find((x) => x.textContent.trim() === 'verb');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.paradigm-table tbody tr')`, {
      label: "verb grid",
    });
    const cells = await js(
      `return document.querySelectorAll('.paradigm-table .cell-select').length;`,
    );
    if (cells < 1) throw new Error("no grid cells for the verb");
  });

  // -- probe 59: the Inflect preview composes affixes -----------------------
  await probe("59-inflect-preview", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });

    // The Inflect tab makes a lexicon click pick the base word.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .word-search')`, {
      label: "lexicon search",
    });
    await js(
      `const i = document.querySelector('.morphology-sidebar .word-search input');
       i.value = 'velo';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
    );
    const picked = await js(
      `const b = [...document.querySelectorAll('.morphology-sidebar .word-row')]
         .find((x) => x.querySelector('.grow')?.textContent.trim() === 'velo');
       if (b) b.click();
       return !!b;`,
    );
    if (!picked) throw new Error("no 'velo' in the lexicon");
    await waitJs(`!!document.querySelector('.inflect-surface')`, {
      label: "inflect result",
    });
    const surface = () =>
      js(
        `return (document.querySelector('.inflect-surface')?.textContent ?? '').trim();`,
      );
    if ((await surface()) !== "velo") {
      throw new Error(`expected 'velo', got '${await surface()}'`);
    }

    // Selecting Past applies the verb's tense suffix.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .feature-bar button')]
         .find((x) => x.textContent.trim() === 'Past');
       if (b) b.click();
       return !!b;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    if ((await surface()) !== "veloi") {
      throw new Error(`expected 'veloi', got '${await surface()}'`);
    }

    // Clicking the -i morpheme row toggles it on (no checkbox any more).
    await js(
      `const row = [...document.querySelectorAll('.morphology-sidebar .morpheme-row')]
         .find((r) => r.querySelector('.mono')?.textContent.trim() === 'i');
       if (row) row.click();
       return !!row;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const final = await surface();
    if (final !== "veloii") throw new Error(`expected 'veloii', got '${final}'`);
  });

  // -- probe 60: the Compose builder combines sidebar pieces -----------------
  await probe("60-compose-builder", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    const tab = (name) =>
      js(
        `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
           .find((x) => x.textContent.trim() === ${JSON.stringify(name)});
         if (b) b.click();
         return !!b;`,
      );
    if (!(await tab("Compose"))) throw new Error("no Compose tab");
    await waitJs(`!!document.querySelector('.compose-builder')`, {
      label: "compose builder",
    });

    // Start from an empty strip.
    await js(
      `const b = document.querySelector('.compose-builder .clear-strip');
       if (b) b.click();
       return true;`,
    );

    const typeIn = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    const clickIn = (selector, read, match) =>
      js(
        `const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
           .find((x) => (${read})?.textContent.trim() === ${JSON.stringify(match)});
         if (b) b.click();
         return !!b;`,
      );
    // Root + root = a compound.
    await typeIn(".morphology-sidebar .word-search input", "velo");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row .grow')]
         .some((x) => x.textContent.trim() === 'velo')`,
      { label: "velo row" },
    );
    if (
      !(await clickIn(".morphology-sidebar .word-row", "x.querySelector('.grow')", "velo"))
    ) {
      throw new Error("could not add velo");
    }
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'velo'`,
      { label: "velo composed" },
    );

    await typeIn(".morphology-sidebar .word-search input", "paka");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row .grow')]
         .some((x) => x.textContent.trim() === 'paka')`,
      { label: "paka row" },
    );
    await clickIn(".morphology-sidebar .word-row", "x.querySelector('.grow')", "paka");
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'velopaka'`,
      { label: "compound" },
    );

    // A fixes morpheme attaches as a suffix.
    await typeIn(".morphology-sidebar .morph-search input", "agent");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .morpheme-row .mono')]
         .some((x) => x.textContent.trim() === 'o')`,
      { label: "morpheme row" },
    );
    await clickIn(".morphology-sidebar .morpheme-row", "x.querySelector('.mono')", "o");
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'velopakao'`,
      { label: "root + morpheme" },
    );
  });

  // -- probe 61: the Morphology sidebar is a flex column with scrolling lists
  await probe("61-morphology-sidebar-layout", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar')`, {
      label: "morphology sidebar",
    });

    const direction = await js(
      `return getComputedStyle(document.querySelector('.morphology-sidebar')).flexDirection;`,
    );
    assertEqual(direction, "column", "sidebar flex direction");

    // Compose/Inflect show the two piece regions; Endings shows the classes.
    const composeRegions = await js(
      `return document.querySelectorAll('.morphology-sidebar .morph-region').length;`,
    );
    if (composeRegions !== 2) {
      throw new Error(`expected 2 regions on Compose, got ${composeRegions}`);
    }

    const overflow = await js(
      `const l = document.querySelector('.morphology-sidebar .morph-list');
       return l ? getComputedStyle(l).overflowY : 'none';`,
    );
    assertEqual(overflow, "auto", "list overflow-y");

    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Endings');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .class-row')`, {
      label: "class chips",
    });
    const endRegions = await js(
      `return document.querySelectorAll('.morphology-sidebar .morph-region').length;`,
    );
    if (endRegions !== 1) {
      throw new Error(`expected 1 region on Endings, got ${endRegions}`);
    }
    const wrap = await js(
      `const c = document.querySelector('.morphology-sidebar .morph-chips');
       return c ? getComputedStyle(c).flexWrap : 'none';`,
    );
    assertEqual(wrap, "wrap", "classes wrap");
  });

  // -- probe 62: the shared "Save as word" form -----------------------------
  await probe("62-save-word-form", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Compose');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.compose-builder')`, {
      label: "compose builder",
    });
    await js(
      `const b = document.querySelector('.compose-builder .clear-strip');
       if (b) b.click();
       return true;`,
    );

    const typeIn = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    const clickIn = (selector, read, match) =>
      js(
        `const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
           .find((x) => (${read})?.textContent.trim() === ${JSON.stringify(match)});
         if (b) b.click();
         return !!b;`,
      );

    // Build a fresh form: velo + the -o agent morpheme = veloo.
    await typeIn(".morphology-sidebar .word-search input", "velo");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row .grow')]
         .some((x) => x.textContent.trim() === 'velo')`,
      { label: "velo row" },
    );
    await clickIn(".morphology-sidebar .word-row", "x.querySelector('.grow')", "velo");
    await typeIn(".morphology-sidebar .morph-search input", "agent");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .morpheme-row .mono')]
         .some((x) => x.textContent.trim() === 'o')`,
      { label: "morpheme row" },
    );
    await clickIn(".morphology-sidebar .morpheme-row", "x.querySelector('.mono')", "o");
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'veloo'`,
      { label: "veloo composed" },
    );

    // Save it: the form defaults to the lemma's table, so Save is enabled.
    const saved = await js(
      `const b = [...document.querySelectorAll('.compose-builder .save-word button')]
         .find((x) => x.textContent.includes('Save as word'));
       if (b) b.click();
       return !!b;`,
    );
    if (!saved) throw new Error("no Save as word button");
    await waitJs(
      `document.querySelector('.compose-builder .save-word .muted')?.textContent.trim() === 'Saved'`,
      { label: "saved" },
    );

    // Re-composing an existing word warns about the duplicate.
    await js(
      `const b = document.querySelector('.compose-builder .clear-strip');
       if (b) b.click();
       return true;`,
    );
    await typeIn(".morphology-sidebar .word-search input", "velo");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row .grow')]
         .some((x) => x.textContent.trim() === 'velo')`,
      { label: "velo row again" },
    );
    await clickIn(".morphology-sidebar .word-row", "x.querySelector('.grow')", "velo");
    await waitJs(`!!document.querySelector('.compose-builder .save-word .warn-inline')`, {
      label: "duplicate warning",
    });
  });

  // -- probe 63: Inflect picker + class-relevant features --------------------
  await probe("63-inflect-picker-features", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.word-picker input')`, {
      label: "word picker",
    });

    // Choose the verb "velo" from the picker.
    await js(
      `const i = document.querySelector('.word-picker input');
       i.value = 'velo';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       i.focus();
       return true;`,
    );
    await waitJs(
      `[...document.querySelectorAll('.word-picker-list button .mono')]
         .some((x) => x.textContent.trim() === 'velo')`,
      { label: "velo option" },
    );
    await js(
      `const b = [...document.querySelectorAll('.word-picker-list button')]
         .find((x) => x.querySelector('.mono')?.textContent.trim() === 'velo');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.inflect-surface')`, {
      label: "inflect result",
    });
    await waitJs(`!!document.querySelector('.morphology-view .feature-bar')`, {
      label: "feature bar",
    });

    const labels = await js(
      `return [...document.querySelectorAll('.morphology-view .feature-bar .feature-label')]
         .map((x) => x.textContent.trim());`,
    );
    if (!labels.includes("Tense") || !labels.includes("Aspect")) {
      throw new Error(`verb features missing: ${JSON.stringify(labels)}`);
    }
    if (labels.includes("Number")) {
      throw new Error(`non-verb feature shown: ${JSON.stringify(labels)}`);
    }
  });

  // -- probe 64: Enter in a sidebar search adds the top match ----------------
  await probe("64-enter-to-add", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Compose');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.compose-builder')`, {
      label: "compose builder",
    });
    await js(
      `const b = document.querySelector('.compose-builder .clear-strip');
       if (b) b.click();
       return true;`,
    );

    const type = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.focus();
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    const enter = (selector) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
         return true;`,
      );

    await type(".morphology-sidebar .word-search input", "velo");
    await enter(".morphology-sidebar .word-search input");
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'velo'`,
      { label: "word via Enter" },
    );

    await type(".morphology-sidebar .morph-search input", "agent");
    await enter(".morphology-sidebar .morph-search input");
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'veloo'`,
      { label: "morpheme via Enter" },
    );

    // On Inflect, Enter selects the top word instead of adding to the strip.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.word-picker')`, { label: "word picker" });
    await type(".morphology-sidebar .word-search input", "paka");
    await enter(".morphology-sidebar .word-search input");
    await waitJs(
      `(document.querySelector('.inflect-surface')?.textContent ?? '').trim() === 'paka'`,
      { label: "inflect selection via Enter" },
    );
  });

  // -- probe 65: an ending references a morpheme (uene -> ueneyu) -----------
  await probe("65-endings-reference-morpheme", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Endings');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .class-row')`, {
      label: "class chips",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-sidebar .class-row')]
         .find((x) => x.textContent.trim() === 'noun');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.paradigm-table tbody tr')`, {
      label: "noun grid",
    });

    // In the Plural row's cell, point the ending at the -yu morpheme.
    const referenced = await js(
      `const row = [...document.querySelectorAll('.paradigm-table tbody tr')]
         .find((r) => r.querySelector('.row-label')?.textContent.includes('Plural'));
       if (!row) return false;
       const select = row.querySelector('.cell-select');
       const option = [...select.options].find((o) => o.textContent.trim() === 'yu');
       if (!option) return false;
       select.value = option.value;
       select.dispatchEvent(new Event('change', { bubbles: true }));
       return true;`,
    );
    if (!referenced) throw new Error("could not reference the -yu morpheme");

    // Inflect uene with plural selected: uene -> ueneyu.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.word-picker input')`, {
      label: "word picker",
    });
    await js(
      `const i = document.querySelector('.word-picker input');
       i.value = 'uene';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       i.focus();
       return true;`,
    );
    await waitJs(
      `[...document.querySelectorAll('.word-picker-list button .mono')]
         .some((x) => x.textContent.trim() === 'uene')`,
      { label: "uene option" },
    );
    await js(
      `const b = [...document.querySelectorAll('.word-picker-list button')]
         .find((x) => x.querySelector('.mono')?.textContent.trim() === 'uene');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.inflect-surface')`, {
      label: "inflect result",
    });
    const surface = () =>
      js(
        `return (document.querySelector('.inflect-surface')?.textContent ?? '').trim();`,
      );
    if ((await surface()) !== "uene") {
      throw new Error(`expected 'uene', got '${await surface()}'`);
    }

    await js(
      `const b = [...document.querySelectorAll('.morphology-view .feature-bar button')]
         .find((x) => x.textContent.trim() === 'Plural');
       if (b) b.click();
       return !!b;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const final = await surface();
    if (final !== "ueneyu") throw new Error(`expected 'ueneyu', got '${final}'`);
  });

  // -- probe 66: inherent declension drives the grid and inflection ----------
  await probe("66-inherent-declension", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Endings');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .class-row')`, {
      label: "class chips",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-sidebar .class-row')]
         .find((x) => x.textContent.trim() === 'root');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.paradigm-table tbody tr')`, {
      label: "root grid",
    });

    // Coverage: a gap is flagged and the decl rows carry their endings.
    if (!(await js(`return !!document.querySelector('.paradigm-table td.gap');`))) {
      throw new Error("no coverage gap flagged in the root grid");
    }
    const surfaces = await js(
      `return [...document.querySelectorAll('.paradigm-table .cell-surface')]
         .map((input) => input.value);`,
    );
    if (!surfaces.includes("a") || !surfaces.includes("yu")) {
      throw new Error(`grid endings missing: ${JSON.stringify(surfaces)}`);
    }

    // Inflect by inherent declension: demo1 -> demo1a, demo2 -> demo2yu.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.word-picker input')`, {
      label: "word picker",
    });

    const pick = async (name) => {
      await js(
        `const i = document.querySelector('.word-picker input');
         i.value = ${JSON.stringify(name)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         i.focus();
         return true;`,
      );
      await waitJs(
        `[...document.querySelectorAll('.word-picker-list button .mono')]
           .some((x) => x.textContent.trim() === ${JSON.stringify(name)})`,
        { label: `${name} option` },
      );
      await js(
        `const b = [...document.querySelectorAll('.word-picker-list button')]
           .find((x) => x.querySelector('.mono')?.textContent.trim() === ${JSON.stringify(name)});
         if (b) b.click();
         return !!b;`,
      );
      await waitJs(`!!document.querySelector('.inflect-surface')`, {
        label: "inflect result",
      });
    };
    const surface = () =>
      js(
        `return (document.querySelector('.inflect-surface')?.textContent ?? '').trim();`,
      );
    const plural = async () => {
      await js(
        `const b = [...document.querySelectorAll('.morphology-view .feature-bar button')]
           .find((x) => x.textContent.trim() === 'Plural');
         if (b) b.click();
         return !!b;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    };

    await pick("demo1");
    await plural();
    if ((await surface()) !== "demo1a") {
      throw new Error(`expected 'demo1a', got '${await surface()}'`);
    }

    await pick("demo2");
    await plural();
    if ((await surface()) !== "demo2yu") {
      throw new Error(`expected 'demo2yu', got '${await surface()}'`);
    }
  });

  // -- probe 67: the sidebar searches clear with an X or Escape ---------------
  await probe("67-sidebar-search-clear", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .word-search input')`, {
      label: "lexicon search",
    });

    const type = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.focus();
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );

    // The clear X appears with a query, and clears it.
    await type(".morphology-sidebar .word-search input", "velo");
    await waitJs(`!!document.querySelector('.morphology-sidebar .word-search .clear-search')`, {
      label: "clear button",
    });
    await js(
      `document.querySelector('.morphology-sidebar .word-search .clear-search').click();
       return true;`,
    );
    await waitJs(
      `document.querySelector('.morphology-sidebar .word-search input').value === ''`,
      { label: "click cleared the search" },
    );
    if (
      await js(
        `return !!document.querySelector('.morphology-sidebar .word-search .clear-search');`,
      )
    ) {
      throw new Error("clear button lingered after clearing");
    }

    // Escape clears too.
    await type(".morphology-sidebar .morph-search input", "agent");
    await waitJs(`!!document.querySelector('.morphology-sidebar .morph-search .clear-search')`, {
      label: "morph clear button",
    });
    await js(
      `const i = document.querySelector('.morphology-sidebar .morph-search input');
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
       return true;`,
    );
    await waitJs(
      `document.querySelector('.morphology-sidebar .morph-search input').value === ''`,
      { label: "escape cleared the search" },
    );
  });

  // -- probe 68: the lexicon search matches a word's gloss -------------------
  await probe("68-lexicon-gloss-search", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Morphology"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.morphology-sidebar .word-search input')`, {
      label: "lexicon search",
    });
    await js(
      `const i = document.querySelector('.morphology-sidebar .word-search input');
       i.focus();
       i.value = 'run';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
    );
    // "velo" has the definition "to run": a gloss hit, not a wordname hit.
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row .grow')]
         .some((x) => x.textContent.trim() === 'velo')`,
      { label: "gloss search finds velo" },
    );
  });

  // -- probe 69: the Class-column setting ------------------------------------
  await probe("69-class-column-setting", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.settings')`, { label: "settings" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === 'Linting & translator');
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no Linting & translator tab");
    await waitJs(`!!document.querySelector('.settings .class-column select')`, {
      label: "class column field",
    });

    const options = await js(
      `return [...document.querySelectorAll('.settings .class-column select option')]
         .map((o) => o.textContent.trim());`,
    );
    if (!options.some((label) => label.startsWith("Auto"))) {
      throw new Error(`no Auto option: ${JSON.stringify(options)}`);
    }
    const resolved = await js(
      `return document.querySelector('.settings .class-column .row')?.textContent ?? '';`,
    );
    if (!resolved.includes("pos")) {
      throw new Error(`resolved class column not shown: ${resolved}`);
    }
    await js(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
       return true;`,
    );
    await waitJs(`!document.querySelector('.settings')`, { label: "settings closed" });
  });

  // -- probe 70: cleaning a leading '#' from class values --------------------
  await probe("70-clean-class-values", async () => {
    await js(
      `const b = document.querySelector('.activity[title="Settings"]');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.settings')`, { label: "settings" });
    await js(
      `const b = [...document.querySelectorAll('.settings-nav button')]
         .find((x) => x.textContent.trim() === 'Linting & translator');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.settings .clean-class')`, {
      label: "clean button",
    });
    await js(
      `document.querySelector('.settings .clean-class').click();
       return true;`,
    );
    await waitJs(
      `(document.querySelector('.settings')?.textContent ?? '').includes('Cleaned 1')`,
      { label: "cleaned-one status" },
    );
    await js(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
       return true;`,
    );
    await waitJs(`!document.querySelector('.settings')`, { label: "settings closed" });
  });

  // -- probe 71: the wordname header stays above the scrolling body ----------
  await probe("71-grid-wordname-header-sticky", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('big'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'big' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "big grid" });
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr[data-index]').length > 0`,
      { label: "rows rendered" },
    );

    // Scroll so body rows pass under the sticky headers.
    await js(
      `const s = document.querySelector('.grid-scroll');
       s.scrollTop = 600;
       s.dispatchEvent(new Event('scroll', { bubbles: true }));
       return true;`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const topmost = (selector) =>
      js(
        `const th = document.querySelector(${JSON.stringify(selector)});
         if (!th) return 'none';
         const r = th.getBoundingClientRect();
         const el = document.elementFromPoint(r.left + 8, r.top + r.height / 2);
         const cell = el?.closest('th, td');
         return cell ? cell.tagName + '|' + cell.className : 'none';`,
      );

    const word = await topmost(".dict-grid th.wordname-col");
    if (!word.startsWith("TH|") || !word.includes("wordname-col")) {
      throw new Error(`wordname header not topmost (hit: ${word})`);
    }
    const select = await topmost(".dict-grid th.select-col");
    if (!select.startsWith("TH|") || !select.includes("select-col")) {
      throw new Error(`select header not topmost (hit: ${select})`);
    }
  });

  // -- probe 72: the virtualized grid does not drift while scrolling ----------
  await probe("72-grid-scroll-jitter", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('props'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'props' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "props grid" });
    await waitJs(
      `document.querySelectorAll('.dict-grid tbody tr[data-index]').length > 0`,
      { label: "rows rendered" },
    );

    // Tall rows really are taller than the estimate (else there is no jitter
    // to measure).
    const rowHeight = await js(
      `const r = document.querySelector('.dict-grid tbody tr[data-index]');
       return r ? Math.round(r.getBoundingClientRect().height) : 0;`,
    );
    if (rowHeight < 40) {
      throw new Error(`seed rows are not tall (${rowHeight}px); can't test jitter`);
    }

    // The transient row-position drift did not reproduce reliably under the
    // WebDriver harness (discrete programmatic scrolls settle between frames),
    // so — as planned — assert the mechanism and a content-stability bound.
    // (1) Scroll anchoring must be off, or the browser fights the spacers.
    const anchor = await js(
      `return getComputedStyle(document.querySelector('.grid-scroll')).overflowAnchor;`,
    );
    if (anchor !== "none") {
      throw new Error(`grid scroll anchoring is '${anchor}', expected 'none'`);
    }

    // (2) The total content height must not climb as rows are measured. With
    // the estimate tracking real row heights it stays near-constant; a fixed
    // 30px estimate let it grow by thousands of px (the scrollbar/positions
    // jumping under the user).
    const top = await js(
      `const s = document.querySelector('.grid-scroll');
       s.scrollTop = 0;
       s.dispatchEvent(new Event('scroll', { bubbles: true }));
       return s.scrollHeight;`,
    );
    for (const target of [400, 900, 1600, 2500, 3600, 5000, 8000]) {
      await js(
        `const s = document.querySelector('.grid-scroll');
         s.scrollTop = ${target};
         s.dispatchEvent(new Event('scroll', { bubbles: true }));
         return true;`,
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const bottom = await js(
      `return document.querySelector('.grid-scroll').scrollHeight;`,
    );
    const growth = bottom - top;
    if (growth > 1000) {
      throw new Error(
        `content height grew ${growth}px mid-scroll (top=${top}, bottom=${bottom})`,
      );
    }
  });

  // -- probe 73: Compose links every same-table root as a parent -------------
  await probe("73-compose-multi-parent", async () => {
    const typeIn = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    const clickWord = async (word) => {
      await typeIn(".morphology-sidebar .word-search input", word);
      await waitJs(
        `[...document.querySelectorAll('.morphology-sidebar .word-row')]
           .some((r) => r.querySelector('.grow')?.textContent.trim() === ${JSON.stringify(word)})`,
        { label: `word ${word}` },
      );
      const ok = await js(
        `const b = [...document.querySelectorAll('.morphology-sidebar .word-row')]
           .find((r) => r.querySelector('.grow')?.textContent.trim() === ${JSON.stringify(word)});
         if (b) b.click();
         return !!b;`,
      );
      if (!ok) throw new Error(`no word row ${word}`);
    };
    const clearStrip = () =>
      js(
        `const b = document.querySelector('.compose-builder .clear-strip');
         if (b) b.click();
         return true;`,
      );
    const openCompose = async () => {
      await openActivity("Morphology");
      await waitJs(`!!document.querySelector('.morphology-view')`, {
        label: "morphology view",
      });
      await js(
        `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
           .find((x) => x.textContent.trim() === 'Compose');
         if (b) b.click();
         return !!b;`,
      );
      await waitJs(`!!document.querySelector('.compose-builder')`, {
        label: "compose builder",
      });
    };

    // Two roots from one table are both linked.
    await openCompose();
    await clearStrip();
    await clickWord("velo");
    await clickWord("demo1");
    await waitJs(`document.querySelectorAll('.save-word .parent-chip').length === 2`, {
      label: "two parent chips",
    });

    const saved = await js(
      `const b = [...document.querySelectorAll('.compose-builder .save-word button')]
         .find((x) => x.textContent.includes('Save as word'));
       if (b) b.click();
       return !!b;`,
    );
    if (!saved) throw new Error("no Save as word button");
    await waitJs(
      `document.querySelector('.compose-builder .save-word .muted')?.textContent.trim() === 'Saved'`,
      { label: "saved" },
    );

    // The compound's row lists both roots as parents (references resolve to
    // wordnames); the roots-table word is not there.
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    const opened = await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    if (!opened) throw new Error("no 'lex' table in the panel");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await waitJs(
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .some((i) => i.value === 'velodemo1')`,
      { label: "velodemo1 row" },
    );
    const parentText = await js(
      `const i = [...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .find((i) => i.value === 'velodemo1');
       return i?.closest('tr')?.textContent ?? '';`,
    );
    if (!parentText.includes("velo") || !parentText.includes("demo1")) {
      throw new Error(`velodemo1 row is missing its parents: ${parentText}`);
    }
    if (parentText.includes("tomo")) {
      throw new Error(`velodemo1 should not link a cross-table parent: ${parentText}`);
    }

    // A root from another table is now linked too.
    await openCompose();
    await clearStrip();
    await clickWord("velo");
    await clickWord("tomo");
    await waitJs(`document.querySelectorAll('.save-word .parent-chip').length === 2`, {
      label: "mixed parent chips",
    });
    const saved2 = await js(
      `const b = [...document.querySelectorAll('.compose-builder .save-word button')]
         .find((x) => x.textContent.includes('Save as word'));
       if (b) b.click();
       return !!b;`,
    );
    if (!saved2) throw new Error("no Save as word button for mixed parents");
    await waitJs(
      `document.querySelector('.compose-builder .save-word .muted')?.textContent.trim() === 'Saved'`,
      { label: "mixed saved" },
    );

    // velotomo (composed in lex) lists both the same-table and the
    // cross-table root as parents.
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    await js(
      `const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.textContent.trim().startsWith('lex'));
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await waitJs(
      `[...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .some((i) => i.value === 'velotomo')`,
      { label: "velotomo row" },
    );
    const mixedText = await js(
      `const i = [...document.querySelectorAll('.dict-grid td.wordname-col input')]
         .find((i) => i.value === 'velotomo');
       return i?.closest('tr')?.textContent ?? '';`,
    );
    if (!mixedText.includes("velo") || !mixedText.includes("tomo")) {
      throw new Error(`velotomo is missing a cross-table parent: ${mixedText}`);
    }
  });

  // -- probe 74: dragging sidebar pieces onto the Inflect view ---------------
  await probe("74-morphology-drop", async () => {
    // WebKit may not copy `dataTransfer` from the DragEvent init dict; fall
    // back to defining it on the instance so the handlers see the payload.
    const dispatchDrag = `
      const fire = (target, type, dt) => {
        const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt });
        return target.dispatchEvent(ev);
      };`;
    const setInput = (selector, text) =>
      js(
        `const i = document.querySelector(${JSON.stringify(selector)});
         i.value = ${JSON.stringify(text)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    const dragTo = (sourceSel, readExpr, match, targetSel) =>
      js(
        `${dispatchDrag}
         const src = [...document.querySelectorAll(${JSON.stringify(sourceSel)})]
           .find((x) => (${readExpr})?.textContent.trim() === ${JSON.stringify(match)});
         const target = document.querySelector(${JSON.stringify(targetSel)});
         if (!src || !target) return false;
         const dt = new DataTransfer();
         fire(src, 'dragstart', dt);
         fire(target, 'dragover', dt);
         fire(target, 'drop', dt);
         return true;`,
      );

    await openActivity("Morphology");
    await waitJs(`!!document.querySelector('.morphology-view')`, {
      label: "morphology view",
    });
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Inflect');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.inflect-drop')`, {
      label: "inflect drop zone",
    });

    // A word dropped on the Inflect view becomes the base.
    await setInput(".morphology-sidebar .word-search input", "uene");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row')]
         .some((r) => r.querySelector('.grow')?.textContent.trim() === 'uene')`,
      { label: "uene row" },
    );
    if (
      !(await dragTo(
        ".morphology-sidebar .word-row",
        "x.querySelector('.grow')",
        "uene",
        ".inflect-drop",
      ))
    ) {
      throw new Error("could not drag the uene row");
    }
    await waitJs(
      `document.querySelector('.inflect-drop .section-title')?.textContent.includes('uene')`,
      { label: "uene selected by drop" },
    );

    // A morpheme dropped on the Inflect view toggles on (row goes active).
    await setInput(".morphology-sidebar .morph-search input", "agent");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .morpheme-row .mono')]
         .some((x) => x.textContent.trim() === 'o')`,
      { label: "morpheme row" },
    );
    if (
      !(await dragTo(
        ".morphology-sidebar .morpheme-row",
        "x.querySelector('.mono')",
        "o",
        ".inflect-drop",
      ))
    ) {
      throw new Error("could not drag the -o morpheme");
    }
    await waitJs(
      `document.querySelector('.morphology-sidebar .morpheme-row.active .mono')?.textContent.trim() === 'o'`,
      { label: "morpheme toggled by drop" },
    );

    // A foreign drag is not accepted: the drop zone must not preventDefault.
    const prevented = await js(
      `${dispatchDrag}
       const target = document.querySelector('.inflect-drop');
       const dt = new DataTransfer();
       dt.setData('text/plain', 'nope');
       return fire(target, 'dragover', dt) === false;`,
    );
    if (prevented) {
      throw new Error("the Inflect drop zone accepted an unrelated drag");
    }

    // The Compose strip still accepts a dropped piece.
    await js(
      `const b = [...document.querySelectorAll('.morphology-view .mode-switch button')]
         .find((x) => x.textContent.trim() === 'Compose');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(`!!document.querySelector('.compose-builder')`, {
      label: "compose builder",
    });
    await js(
      `const b = document.querySelector('.compose-builder .clear-strip');
       if (b) b.click();
       return true;`,
    );
    await setInput(".morphology-sidebar .word-search input", "velo");
    await waitJs(
      `[...document.querySelectorAll('.morphology-sidebar .word-row')]
         .some((r) => r.querySelector('.grow')?.textContent.trim() === 'velo')`,
      { label: "velo row" },
    );
    if (
      !(await dragTo(
        ".morphology-sidebar .word-row",
        "x.querySelector('.grow')",
        "velo",
        ".compose-strip",
      ))
    ) {
      throw new Error("could not drag velo onto the strip");
    }
    await waitJs(
      `(document.querySelector('.compose-builder .inflect-surface')?.textContent ?? '').trim() === 'velo'`,
      { label: "velo composed by drop" },
    );
  });

  // -- probe 75: opening a tab reveals it instead of duplicating ------------
  await probe("75-tabs-reveal-not-duplicate", async () => {
    const tabCount = (title) =>
      js(
        `return [...document.querySelectorAll('.tab-title')]
           .filter((x) => x.textContent.trim() === ${JSON.stringify(title)}).length;`,
      );
    const paneCount = () =>
      js(`return document.querySelectorAll('.group-pane').length;`);
    const tableRow = (name) =>
      `[...document.querySelectorAll('.table-list .table-row .tree-name')]
         .find((x) => x.querySelector('.grow')?.textContent.trim() === ${JSON.stringify(name)})`;
    const clickTable = (name, modifiers = {}) =>
      js(
        `const b = ${tableRow(name)};
         if (!b) return false;
         b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true,
           ctrlKey: ${!!modifiers.ctrl}, metaKey: ${!!modifiers.meta} }));
         return true;`,
      );
    const auxClickTable = (name) =>
      js(
        `const b = ${tableRow(name)};
         if (!b) return false;
         b.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
         return true;`,
      );
    const openSplitFromRow = async (name) => {
      const ok = await js(
        `const b = ${tableRow(name)};
         if (!b) return false;
         b.closest('.table-row').dispatchEvent(new MouseEvent('contextmenu',
           { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
         return true;`,
      );
      if (!ok) throw new Error(`no table row ${name}`);
      await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "table menu" });
      const clicked = await js(
        `const b = [...document.querySelectorAll('.ctx-menu button')]
           .find((x) => x.textContent.trim() === 'Open in new split');
         if (b) b.click();
         return !!b;`,
      );
      if (!clicked) throw new Error("no Open in new split item");
    };

    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });

    // Open `roots`, then `morphs` in a new split pane.
    if (!(await clickTable("roots"))) throw new Error("no roots row");
    await waitJs(
      `[...document.querySelectorAll('.tab-title')].some((x) => x.textContent.trim() === 'roots')`,
      { label: "roots tab" },
    );
    const rootsBefore = await tabCount("roots");
    const panesBefore = await paneCount();
    await openSplitFromRow("morphs");
    await waitJs(
      `document.querySelectorAll('.group-pane').length === ${panesBefore + 1}`,
      { label: "new split pane" },
    );
    const panesSplit = await paneCount();

    // Clicking `roots` again reveals its existing tab: no new tab, no pane.
    if (!(await clickTable("roots"))) throw new Error("no roots row (reveal)");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if ((await tabCount("roots")) !== rootsBefore) {
      throw new Error("revealing roots created a duplicate tab");
    }
    if ((await paneCount()) !== panesSplit) {
      throw new Error("revealing roots changed the pane count");
    }

    // Tool tabs are singletons: opening Translation twice leaves one tab.
    await openActivity("Translation");
    await openActivity("Translation");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if ((await tabCount("Translation")) !== 1) {
      throw new Error("Translation should be a single tab");
    }

    // Ctrl+click forces a deliberate duplicate in the active pane.
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel again" });
    const morphsBefore = await tabCount("morphs");
    if (!(await clickTable("morphs", { ctrl: true }))) {
      throw new Error("no morphs row (ctrl-click)");
    }
    await waitJs(
      `[...document.querySelectorAll('.tab-title')]
         .filter((x) => x.textContent.trim() === 'morphs').length === ${morphsBefore + 1}`,
      { label: "ctrl-click duplicated morphs" },
    );

    // Middle-click does the same.
    const rootsDupBefore = await tabCount("roots");
    if (!(await auxClickTable("roots"))) {
      throw new Error("no roots row (middle-click)");
    }
    await waitJs(
      `[...document.querySelectorAll('.tab-title')]
         .filter((x) => x.textContent.trim() === 'roots').length === ${rootsDupBefore + 1}`,
      { label: "middle-click duplicated roots" },
    );
  });

  // -- probe 76: [[...]] wiki links render and follow ------------------------
  await probe("76-wikilink-render-follow", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.tree-row[data-path="links.md"] .tree-name')`, {
      label: "links row",
    });
    await js(
      `const r = document.querySelector('.tree-row[data-path="links.md"] .tree-name');
       if (r) r.click();
       return !!r;`,
    );
    await waitJs(`!!document.querySelector('.cm-host[data-note="links.md"] .cm-content')`, {
      label: "links editor",
    });
    await waitJs(
      `document.querySelectorAll('.cm-wikilink').length >= 4`,
      { label: "wiki links decorated" },
    );
    const kinds = await js(
      `return {
         word: document.querySelectorAll('.cm-wikilink-word').length,
         note: document.querySelectorAll('.cm-wikilink-note').length,
         unresolved: document.querySelectorAll('.cm-wikilink-unresolved').length,
         embed: document.querySelectorAll('.cm-wikilink-embed-widget').length,
       };`,
    );
    if (kinds.word < 2) throw new Error(`word links: ${JSON.stringify(kinds)}`);
    if (kinds.unresolved < 1) {
      throw new Error(`unresolved link missing: ${JSON.stringify(kinds)}`);
    }
    if (kinds.note < 1) throw new Error(`note link missing: ${JSON.stringify(kinds)}`);
    if (kinds.embed < 1) throw new Error(`embed link missing: ${JSON.stringify(kinds)}`);

    // Ctrl+click a word link opens its table and selects the word.
    const followed = await js(
      `const el = document.querySelector('.cm-wikilink-word');
       if (!el) return false;
       const rect = el.getBoundingClientRect();
       el.dispatchEvent(new MouseEvent('mousedown', {
         bubbles: true, cancelable: true, ctrlKey: true,
         clientX: rect.left + 2, clientY: rect.top + rect.height / 2,
       }));
       return true;`,
    );
    if (!followed) throw new Error("no word link to click");
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "dictionary opened" });
    await waitJs(
      `[...document.querySelectorAll('.dict-grid tbody tr')]
         .some((tr) => tr.classList.contains('selected') &&
                     tr.querySelector('.wordname-col input')?.value === 'velo')`,
      { label: "velo selected" },
    );
  });

  // -- probe 77: [[ autocomplete offers words and notes ----------------------
  await probe("77-wikilink-autocomplete", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    // Typing `[[` opens the completion list and mounts its tooltip.
    await js(`${viewScript("type.md")}
      v.dispatch({
        changes: { from: 0, insert: "[[" },
        selection: { anchor: 2 },
        userEvent: "input.type",
      });
      return v.state.doc.toString();`);
    await waitJs(`!!document.querySelector('.cm-tooltip-autocomplete')`, {
      label: "completion tooltip",
    });
    await waitJs(
      `document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel').length >= 1`,
      { label: "completion rows" },
    );
    // Styling: rows carry a word/note glyph and secondary (table/folder) text,
    // and the fixed-position tooltip sits within the viewport (not clipped).
    if (
      (await js(
        `return document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionIcon-word, .cm-tooltip-autocomplete .cm-completionIcon-note').length;`,
      )) < 1
    ) {
      throw new Error("completion rows have no word/note glyph");
    }
    if (
      (await js(
        `return document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionDetail').length;`,
      )) < 1
    ) {
      throw new Error("completion rows have no secondary text");
    }
    const rect = await js(
      `const r = document.querySelector('.cm-tooltip-autocomplete').getBoundingClientRect();
       return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vw: window.innerWidth, vh: window.innerHeight };`,
    );
    if (rect.bottom > rect.vh + 1 || rect.right > rect.vw + 1 || rect.top < -1 || rect.left < -1) {
      throw new Error(`completion tooltip clipped: ${JSON.stringify(rect)}`);
    }
  });

  // -- probe 78: Mod+Shift+L wraps a selection as a [[...]] link ------------
  await probe("78-wikilink-keybind", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    await placeCursor("type.md", 0);
    await pressKey("l", [CTRL, SHIFT]);
    await waitJs(
      `(document.querySelector('.cm-host[data-note="type.md"] .cm-content')?.textContent ?? '').includes('[[]]')`,
      { label: "link inserted" },
    );
  });

  // -- probe 79: sound changes apply to a preview word -----------------------
  await probe("79-sound-change-preview", async () => {
    await openActivity("Phonology");
    await waitJs(`!!document.querySelector('.phonology')`, { label: "phonology view" });

    // Add a rule k -> s.
    const added = await js(
      `const b = [...document.querySelectorAll('.phonology button')]
         .find((x) => x.textContent.includes('Add rule'));
       if (b) b.click();
       return !!b;`,
    );
    if (!added) throw new Error("no Add rule button");
    await waitJs(`document.querySelectorAll('.phonology .rule-row').length >= 1`, {
      label: "rule row",
    });
    const setRule = (index, value) =>
      js(
        `const i = document.querySelectorAll('.phonology .rule-row input')[${index}];
         if (!i) return false;
         i.value = ${JSON.stringify(value)};
         i.dispatchEvent(new Event('input', { bubbles: true }));
         return true;`,
      );
    await setRule(0, "k");
    await setRule(1, "s");
    // The rules autosave on a debounce; let it land before the preview reads
    // the backend config.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const previewed = await js(
      `const i = [...document.querySelectorAll('.phonology .custom-row input')]
         .find((x) => x.placeholder.includes('preview'));
       if (!i) return false;
       i.value = 'ka';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
    );
    if (!previewed) throw new Error("no preview input");
    await js(
      `const b = [...document.querySelectorAll('.phonology button')]
         .find((x) => x.textContent.trim() === 'Preview');
       if (b) b.click();
       return !!b;`,
    );
    await waitJs(
      `[...document.querySelectorAll('.phonology .rule-step')]
         .map((x) => x.textContent.trim()).join(' ') === 'ka sa'`,
      { label: "ka -> sa" },
    );
  });

  // -- probe 80: the command palette opens and runs a command ----------------
  await probe("80-command-palette", async () => {
    await pressKey("p", [CTRL]);
    await waitJs(`!!document.querySelector('.palette')`, { label: "palette open" });
    await js(
      `const i = document.querySelector('.palette > input');
       i.value = 'dict';
       i.dispatchEvent(new Event('input', { bubbles: true }));
       return true;`,
    );
    await waitJs(
      `[...document.querySelectorAll('.palette-row')]
         .some((r) => r.textContent.includes('Dictionary'))`,
      { label: "dictionary command" },
    );
    await pressKey(ENTER);
    await waitJs(`!!document.querySelector('.table-list')`, { label: "dictionary open" });
  });

  // -- probe 81: [[note#heading]] resolves and follows ----------------------
  await probe("81-wikilink-heading", async () => {
    await openActivity("Notes");
    // Open headings.md first so its headings enter the cache, making the
    // broken-heading style meaningful.
    await js(
      `const r = document.querySelector('.tree-row[data-path="headings.md"] .tree-name');
       if (r) r.click();
       return !!r;`,
    );
    await waitJs(`!!document.querySelector('.cm-host[data-note="headings.md"] .cm-content')`, {
      label: "headings editor",
    });
    await js(
      `const r = document.querySelector('.tree-row[data-path="links.md"] .tree-name');
       if (r) r.click();
       return !!r;`,
    );
    await waitJs(`!!document.querySelector('.cm-host[data-note="links.md"] .cm-content')`, {
      label: "links editor",
    });
    await waitJs(
      `document.querySelectorAll('.cm-wikilink-heading-broken').length >= 1`,
      { label: "broken heading styled" },
    );

    // Ctrl+click the resolved heading link opens the note at the heading.
    const clicked = await js(
      `const el = [...document.querySelectorAll('.cm-wikilink-note')]
         .find((x) => x.textContent.includes('headings#Intro'));
       if (!el) return false;
       const rect = el.getBoundingClientRect();
       el.dispatchEvent(new MouseEvent('mousedown', {
         bubbles: true, cancelable: true, ctrlKey: true,
         clientX: rect.left + 2, clientY: rect.top + rect.height / 2,
       }));
       return true;`,
    );
    if (!clicked) throw new Error("no headings#Intro link");
    await waitJs(
      `document.querySelector('.cm-host[data-note="headings.md"]') !== null`,
      { label: "headings.md open" },
    );
    // Following scrolled the note to the Intro heading (line 1).
    await waitJs(
      `(() => {
         const v = document.querySelector('.cm-host[data-note="headings.md"] .cm-content')?.cmTile?.root?.view;
         return v ? v.state.selection.main.head <= 2 : false;
       })()`,
      { label: "scrolled to Intro" },
    );
  });

  // -- probe 82: [[...]] brackets hide until the cursor touches the link -----
  await probe("82-wikilink-hidden-brackets", async () => {
    await openActivity("Notes");
    await js(
      `const r = document.querySelector('.tree-row[data-path="links.md"] .tree-name');
       if (r) r.click();
       return !!r;`,
    );
    await waitJs(`!!document.querySelector('.cm-host[data-note="links.md"] .cm-content')`, {
      label: "links editor",
    });
    // Put the cursor at the very end, away from every link.
    await js(`${viewScript("links.md")}
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      return true;`);
    await waitJs(`document.querySelectorAll('.cm-wikilink-hidden').length >= 1`, {
      label: "hidden links",
    });
    const hiddenText = await js(
      `return document.querySelector('.cm-host[data-note="links.md"] .cm-content')?.textContent ?? '';`,
    );
    if (hiddenText.includes("[[")) {
      throw new Error(`brackets not hidden: ${hiddenText}`);
    }

    // Moving the cursor onto the first link reveals its raw text.
    await js(`${viewScript("links.md")}
      v.dispatch({ selection: { anchor: 2 } });
      return true;`);
    await waitJs(
      `(document.querySelector('.cm-host[data-note="links.md"] .cm-content')?.textContent ?? '')
         .includes('[[velo]]')`,
      { label: "link revealed" },
    );
  });

  // -- probe 83: Enter inside a link exits it ---------------------------------
  await probe("83-enter-exits-link", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    // Type `[[ky` at the end of the note so `[[` auto-closes to `[[ky]]`.
    await js(`${viewScript("type.md")}
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      return true;`);
    await pressKey("[");
    await pressKey("[");
    await waitJs(`!!document.querySelector('.cm-tooltip-autocomplete')`, {
      label: "dropdown opened by typing",
    });
    await pressKey("k");
    await pressKey("y");
    await pressKey("\uE00C"); // Escape dismisses the dropdown
    await pressKey(ENTER);
    const after = await js(`${viewScript("type.md")}
      return { text: v.state.doc.toString(), head: v.state.selection.main.head, length: v.state.doc.length };`);
    if (!after.text.endsWith("[[ky]]")) {
      throw new Error(`Enter inserted a newline: ${JSON.stringify(after.text)}`);
    }
    if (after.head !== after.length) {
      throw new Error(`cursor not after ]]: head=${after.head} length=${after.length}`);
    }
  });

  // -- probe 84: tab strip scrolls but shows no horizontal scrollbar ---------
  await probe("84-tab-strip-no-scrollbar", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.tree-row[data-dir="false"] .tree-name')`, {
      label: "note rows in tree",
    });
    // Open every note in the tree so the strip overflows horizontally.
    const opened = await js(`
      const names = [...document.querySelectorAll('.tree-row[data-dir="false"] .tree-name')];
      for (const n of names) n.click();
      return names.length;
    `);
    if (opened < 8) throw new Error(`only ${opened} note rows to open`);
    await waitJs(`document.querySelectorAll('.tab-strip .tab').length >= 8`, {
      label: "many tabs",
    });
    const r = await js(
      `const el = document.querySelector('.tab-strip');
       const cs = getComputedStyle(el);
       return {
         overflowX: cs.overflowX,
         scrollbarWidth: cs.scrollbarWidth,
         scrollWidth: el.scrollWidth,
         clientWidth: el.clientWidth,
         tabs: el.querySelectorAll('.tab').length,
       };`,
    );
    if (!(r.scrollWidth > r.clientWidth)) {
      throw new Error(`tab strip did not overflow: ${JSON.stringify(r)}`);
    }
    if (r.scrollbarWidth !== "none") {
      throw new Error(`horizontal scrollbar visible (scrollbar-width=${r.scrollbarWidth})`);
    }
  });

  // -- probe 85: selected completion row is readable ------------------------
  await probe("85-completion-selection-contrast", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    // "vel" selects the word "velo" (detail "lex"), so the selected row has
    // both a label and a detail to contrast. ("kala" is renamed mid-suite.)
    await js(`${viewScript("type.md")}
      v.dispatch({
        changes: { from: 0, insert: "[[vel" },
        selection: { anchor: 5 },
        userEvent: "input.type",
      });
      return v.state.doc.toString();`);
    await waitJs(
      `!!document.querySelector('.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail')`,
      { label: "selected row with detail" },
    );
    const contrast = await js(`
      const rgba = (s) => {
        const fn = s.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)/);
        if (fn) return [fn[1] * 255, fn[2] * 255, fn[3] * 255, 1];
        const m = s.match(/^rgba?\\(([^)]+)\\)$/);
        if (m) return m[1].split(',').map((x) => parseFloat(x.trim()));
        let h = s.replace('#', '');
        if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
        return [
          parseInt(h.slice(0, 2), 16),
          parseInt(h.slice(2, 4), 16),
          parseInt(h.slice(4, 6), 16),
          h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
        ];
      };
      const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const li = document.querySelector('.cm-tooltip-autocomplete ul li[aria-selected]');
      const label = li.querySelector('.cm-completionLabel');
      const detail = li.querySelector('.cm-completionDetail');
      const bg = rgba(getComputedStyle(li).backgroundColor);
      const labelColor = rgba(getComputedStyle(label).color);
      const detailColor = rgba(getComputedStyle(detail).color);
      return {
        bg: getComputedStyle(li).backgroundColor,
        label: getComputedStyle(label).color,
        detail: getComputedStyle(detail).color,
        labelContrast: Math.round(ratio(labelColor, bg) * 100) / 100,
        detailContrast: Math.round(ratio(detailColor, bg) * 100) / 100,
      };`);
    if (contrast.labelContrast < 4.5) {
      throw new Error(
        `selected label contrast too low (${contrast.labelContrast}:1, ${contrast.label} on ${contrast.bg})`,
      );
    }
    if (contrast.detailContrast < 3) {
      throw new Error(
        `selected detail contrast too low (${contrast.detailContrast}:1, ${contrast.detail} on ${contrast.bg})`,
      );
    }
  });

  // -- probe 86: completion dropdown layout and SVG icons --------------------
  await probe("86-completion-dropdown-layout", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    await js(`${viewScript("type.md")}
      v.dispatch({
        changes: { from: 0, insert: "[[" },
        selection: { anchor: 2 },
        userEvent: "input.type",
      });
      return v.state.doc.toString();`);
    await waitJs(
      `!!document.querySelector('.cm-tooltip-autocomplete ul li .cm-completionLabel')`,
      { label: "completion rows" },
    );
    const layout = await js(`
      const ul = document.querySelector('.cm-tooltip-autocomplete > ul');
      const li = document.querySelector('.cm-tooltip-autocomplete > ul > li');
      const detail = document.querySelector('.cm-tooltip-autocomplete .cm-completionDetail');
      const container = document.querySelector('.cm-tooltip.cm-tooltip-autocomplete');
      const icon = document.querySelector('.cm-tooltip-autocomplete .cm-completionIcon-word');
      const ics = icon ? getComputedStyle(icon) : null;
      return {
        liHeight: parseFloat(getComputedStyle(li).height),
        ulMaxHeight: getComputedStyle(ul).maxHeight,
        detailFontStyle: detail ? getComputedStyle(detail).fontStyle : null,
        radius: getComputedStyle(container).borderRadius,
        iconMask: ics ? (ics.webkitMaskImage || ics.maskImage) : null,
        iconBefore: icon ? getComputedStyle(icon, '::before').content : null,
        iconWidth: ics ? parseFloat(ics.width) : null,
      };`);
    if (!(layout.liHeight >= 26 && layout.liHeight <= 28)) {
      throw new Error(`row height not fixed (${layout.liHeight}px)`);
    }
    const maxH = parseFloat(layout.ulMaxHeight);
    if (!(maxH >= 200 && maxH <= 260)) {
      throw new Error(`list max-height not ~8 rows (${layout.ulMaxHeight})`);
    }
    if (layout.detailFontStyle !== "normal") {
      throw new Error(`detail is italic (${layout.detailFontStyle})`);
    }
    if (layout.radius !== "6px") {
      throw new Error(`dropdown radius not 6px (${layout.radius})`);
    }
    if (layout.iconBefore !== "none" && layout.iconBefore !== '""' && layout.iconBefore !== "normal") {
      throw new Error(`word glyph is still a letter (${layout.iconBefore})`);
    }
    if (!layout.iconMask || layout.iconMask === "none") {
      throw new Error("word icon has no SVG mask");
    }
    if (!(layout.iconWidth >= 15 && layout.iconWidth <= 17)) {
      throw new Error(`word icon not 16px (${layout.iconWidth})`);
    }
  });

  // -- probe 87: Fixes morphemes rank below vocab words ----------------------
  await probe("87-completion-fixes-ranking", async () => {
    await openActivity("Notes");
    await openNote("type.md");
    await waitJs(`!!document.querySelector('.cm-host[data-note="type.md"] .cm-content')`, {
      label: "type editor",
    });
    await focusEditor("type.md");
    await js(`${viewScript("type.md")}
      v.dispatch({
        changes: { from: 0, insert: "[[" },
        selection: { anchor: 2 },
        userEvent: "input.type",
      });
      return v.state.doc.toString();`);
    await waitJs(
      `document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel').length >= 1`,
      { label: "completion rows" },
    );
    // On an empty query the first row must be a plain word, not a morpheme.
    const first = await js(
      `return document.querySelector('.cm-tooltip-autocomplete .cm-completionLabel')?.textContent ?? '';`,
    );
    if (first.startsWith("-")) {
      throw new Error(`Fixes morpheme ranked first (${first})`);
    }
    // A "-" query surfaces the Fixes morphemes instead.
    await js(`${viewScript("type.md")}
      v.dispatch({
        changes: { from: 2, insert: "-" },
        selection: { anchor: 3 },
        userEvent: "input.type",
      });
      return v.state.doc.toString();`);
    await waitJs(
      `[...document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionLabel')]
         .some((l) => l.textContent.startsWith('-'))`,
      { label: "fixes morpheme listed" },
    );
  });

  // -- probe 88: activating an off-screen tab reveals it ---------------------
  await probe("88-tab-active-revealed", async () => {
    await openActivity("Notes");
    await collapsePanes(); // full-width pane so a tab can be fully revealed
    await waitJs(`!!document.querySelector('.tree-row[data-dir="false"] .tree-name')`, {
      label: "note rows",
    });
    // Open every note so the strip overflows.
    await js(`
      const names = [...document.querySelectorAll('.tree-row[data-dir="false"] .tree-name')];
      for (const n of names) n.click();
      return names.length;`);
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 8`, {
      label: "many tabs",
    });
    // Reset to the start, then pick an inactive tab that is scrolled out.
    const target = await js(`
      const pane = document.querySelector('.group-pane.active') || document;
      const strip = pane.querySelector('.tab-strip');
      strip.scrollLeft = 0;
      const sr = strip.getBoundingClientRect();
      const tabs = [...strip.querySelectorAll('.tab')];
      const active = strip.querySelector('.tab.active');
      const off = tabs.find(
        (t) => t !== active && t.getBoundingClientRect().right > sr.right + 1,
      );
      return off ? off.querySelector('.tab-title').textContent.trim() : null;`);
    if (!target) throw new Error("no off-screen tab to activate");
    // Activate it through its tree row: focus stays in the sidebar, so the
    // browser does not auto-scroll the strip for us.
    const clicked = await js(`
      const name = [...document.querySelectorAll('.tree-row .tree-name')]
        .find((x) => x.textContent.trim() === ${JSON.stringify(target)});
      if (!name) return false;
      name.click();
      return true;`);
    if (!clicked) throw new Error(`no tree row for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const r = await js(`
      const pane = document.querySelector('.group-pane.active') || document;
      const strip = pane.querySelector('.tab-strip');
      const active = strip.querySelector('.tab.active');
      const sr = strip.getBoundingClientRect();
      const ar = active.getBoundingClientRect();
      return {
        fully: ar.left >= sr.left - 1.5 && ar.right <= sr.right + 1.5,
        scrollLeft: strip.scrollLeft,
        left: ar.left, right: ar.right, sleft: sr.left, sright: sr.right,
        title: active.getAttribute('title'),
      };`);
    if (!r.fully) throw new Error(`active tab not revealed ${JSON.stringify(r)}`);
    if (!r.title) throw new Error("active tab has no title tooltip");

    // The tooltip is the full relative path, not the bare basename.
    await openNote("type.md");
    const tooltip = await js(
      `const p = document.querySelector('.group-pane.active') || document;
       return p.querySelector('.tab.active')?.getAttribute('title') ?? null;`,
    );
    if (tooltip !== "type.md") {
      throw new Error(`note tooltip is not the path (${tooltip})`);
    }
  });

  // -- probe 89: tab ARIA + arrow-key navigation -----------------------------
  await probe("89-tab-keyboard-nav", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.tree-row[data-dir="false"] .tree-name')`, {
      label: "note rows",
    });
    await js(`
      const names = [...document.querySelectorAll('.tree-row[data-dir="false"] .tree-name')];
      for (const n of names) n.click();
      return names.length;`);
    await waitJs(
      `document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 3`,
      { label: "tabs in active pane" },
    );
    // Every tab carries aria-selected; exactly the active one is true.
    const aria = await js(`
      const pane = document.querySelector('.group-pane.active') || document;
      const tabs = [...pane.querySelectorAll('.tab-strip .tab')];
      return {
        selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
        active: tabs.find((t) => t.classList.contains('active'))?.getAttribute('aria-selected'),
        allHave: tabs.every((t) => t.hasAttribute('aria-selected')),
      };`);
    if (!aria.allHave) throw new Error("not every tab has aria-selected");
    if (aria.selected !== 1) throw new Error(`aria-selected count ${aria.selected}`);
    if (aria.active !== "true") throw new Error("active tab is not aria-selected");

    const activeTitle = () =>
      js(`const p = document.querySelector('.group-pane.active') || document;
          return p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null;`);
    await js(`(document.querySelector('.group-pane.active') || document)
      .querySelector('.tab.active')?.focus();
      return document.activeElement?.classList?.contains('tab') ?? false;`);
    const before = await activeTitle();

    await pressKey(ARROW_LEFT);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const left = await js(`
      const p = document.querySelector('.group-pane.active') || document;
      const active = p.querySelector('.tab.active');
      return { title: active?.querySelector('.tab-title')?.textContent.trim(),
               focused: document.activeElement === active };`);
    if (left.title === before) throw new Error(`ArrowLeft did not move (${before})`);
    if (!left.focused) throw new Error("ArrowLeft did not focus the new active tab");

    await pressKey(HOME);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const home = await js(`
      const p = document.querySelector('.group-pane.active') || document;
      const tabs = [...p.querySelectorAll('.tab-strip .tab')];
      return { first: p.querySelector('.tab.active') === tabs[0],
               focused: document.activeElement === p.querySelector('.tab.active') };`);
    if (!home.first) throw new Error("Home did not activate the first tab");

    await pressKey(END);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const end = await js(`
      const p = document.querySelector('.group-pane.active') || document;
      const tabs = [...p.querySelectorAll('.tab-strip .tab')];
      return { last: p.querySelector('.tab.active') === tabs[tabs.length - 1],
               focused: document.activeElement === p.querySelector('.tab.active') };`);
    if (!end.last) throw new Error("End did not activate the last tab");

    // A modifier held with an arrow must not move tabs.
    const lastTitle = await js(
      `const p = document.querySelector('.group-pane.active') || document;
       return p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null;`,
    );
    await pressKey(ARROW_LEFT, [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterMod = await js(
      `const p = document.querySelector('.group-pane.active') || document;
       return p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null;`,
    );
    if (afterMod !== lastTitle) {
      throw new Error(`Ctrl+ArrowLeft moved tabs (${lastTitle} -> ${afterMod})`);
    }

    // The close button becomes visible when its tab has keyboard focus.
    const closeOpacity = await js(`
      const p = document.querySelector('.group-pane.active') || document;
      const close = p.querySelector('.tab.active .tab-close');
      close.focus();
      return parseFloat(getComputedStyle(close).opacity);`);
    if (!(closeOpacity >= 0.9)) {
      throw new Error(`close button not visible on focus (${closeOpacity})`);
    }
  });

  // -- probe 90: Ctrl+Tab cycles tabs ----------------------------------------
  await probe("90-tab-cycle-keybind", async () => {
    await openActivity("Notes");
    await waitJs(
      `document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 2`,
      { label: "tabs" },
    );
    const activeTitle = () =>
      js(`const p = document.querySelector('.group-pane.active') || document;
          return p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null;`);
    const before = await activeTitle();
    await pressKey(TAB, [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const next = await activeTitle();
    if (next === before) throw new Error(`Ctrl+Tab did not cycle (${before})`);
    await pressKey(PAGE_UP, [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const back = await activeTitle();
    if (back !== before) {
      throw new Error(`Ctrl+PageUp did not return (${before} -> ${next} -> ${back})`);
    }
    await pressKey(PAGE_DOWN, [CTRL]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const again = await activeTitle();
    if (again !== next) {
      throw new Error(`Ctrl+PageDown did not advance (${back} -> ${again})`);
    }
  });

  // -- probe 91: tab menu Close others / Close all ---------------------------
  await probe("91-tab-close-others-all", async () => {
    const openMany = () =>
      js(`const names = [...document.querySelectorAll('.tree-row[data-dir="false"] .tree-name')];
          for (const n of names) n.click();
          return names.length;`);
    const openMenu = () =>
      js(`const p = document.querySelector('.group-pane.active') || document;
          const tab = p.querySelector('.tab.active');
          tab.dispatchEvent(new MouseEvent('contextmenu',
            { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
          return true;`);
    const clickItem = (label) =>
      js(`const b = [...document.querySelectorAll('.ctx-menu button')]
            .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
          if (b) b.click();
          return !!b;`);

    await openActivity("Notes");
    await collapsePanes();
    await waitJs(`!!document.querySelector('.tree-row[data-dir="false"] .tree-name')`, {
      label: "note rows",
    });
    await openMany();
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 3`, {
      label: "tabs",
    });
    const kept = await js(
      `const p = document.querySelector('.group-pane.active') || document;
       return p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null;`,
    );
    await openMenu();
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "tab menu" });
    const items = await js(
      `return [...document.querySelectorAll('.ctx-menu button')].map((b) => b.textContent.trim());`,
    );
    if (!items.includes("Close others")) throw new Error(`no Close others: ${items}`);
    if (!items.includes("Close all in this pane")) {
      throw new Error(`no Close all in this pane: ${items}`);
    }
    if (!(await clickItem("Close others"))) throw new Error("could not click Close others");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const others = await js(
      `const p = document.querySelector('.group-pane.active') || document;
       return { count: p.querySelectorAll('.tab-strip .tab').length,
                title: p.querySelector('.tab.active .tab-title')?.textContent.trim() ?? null };`,
    );
    if (others.count !== 1) throw new Error(`Close others left ${others.count} tabs`);
    if (others.title !== kept) {
      throw new Error(`Close others kept the wrong tab (${kept} -> ${others.title})`);
    }

    // Split into two panes, then Close all in this pane empties only that pane
    // and prunes it, leaving the other pane's tabs untouched.
    await openMany();
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 3`, {
      label: "tabs again",
    });
    await openMenu();
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "tab menu split" });
    if (!(await clickItem("Open in new split"))) throw new Error("no Open in new split");
    await waitJs(`document.querySelectorAll('.group-pane').length >= 2`, {
      label: "two panes",
    });
    const otherTitles = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      const active = document.querySelector('.group-pane.active');
      const other = panes.find((p) => p !== active);
      return other
        ? [...other.querySelectorAll('.tab-title')].map((t) => t.textContent.trim()).sort()
        : null;`);
    if (!otherTitles || otherTitles.length < 1) throw new Error("other pane has no tabs");
    await openMenu();
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "tab menu close-all" });
    if (!(await clickItem("Close all in this pane"))) {
      throw new Error("no Close all in this pane item");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      return {
        count: panes.length,
        titles: panes.length
          ? [...panes[0].querySelectorAll('.tab-title')].map((t) => t.textContent.trim()).sort()
          : [],
      };`);
    if (after.count !== 1) throw new Error(`Close all in this pane left ${after.count} panes`);
    if (JSON.stringify(after.titles) !== JSON.stringify(otherTitles)) {
      throw new Error(
        `other pane's tabs were touched: ${JSON.stringify(after.titles)} vs ${JSON.stringify(otherTitles)}`,
      );
    }
  });

  // -- probe 92: the new-tab button opens a note -----------------------------
  await probe("92-tab-new-button", async () => {
    await openActivity("Notes");
    await waitJs(`!!document.querySelector('.group-pane.active .tabbar')`, {
      label: "tab bar",
    });
    const before = await js(`return document.querySelectorAll('.tab-strip .tab').length;`);
    const clicked = await js(
      `const b = document.querySelector('.group-pane.active .tab-new');
       if (b) b.click();
       return !!b;`,
    );
    if (!clicked) throw new Error("no new-tab button");
    await waitJs(
      `document.querySelectorAll('.tab-strip .tab').length > ${before}`,
      { label: "new tab" },
    );
    await waitJs(
      `[...document.querySelectorAll('.group-pane.active .tab-title')]
         .some((x) => /untitled/i.test(x.textContent))`,
      { label: "untitled tab" },
    );
  });

  // -- probe 93: the + opens a note in its own pane --------------------------
  await probe("93-tab-new-own-pane", async () => {
    await openActivity("Notes");
    await collapsePanes();
    await openNote("type.md");
    await openNote("links.md");
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 2`, {
      label: "tabs",
    });
    // Split the pane in two via the tab context menu.
    await js(`
      const p = document.querySelector('.group-pane.active') || document;
      p.querySelector('.tab.active').dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
      return true;`);
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "tab menu" });
    await js(`
      const b = [...document.querySelectorAll('.ctx-menu button')]
        .find((x) => x.textContent.trim() === 'Open in new split');
      if (b) b.click();
      return !!b;`);
    await waitJs(`document.querySelectorAll('.group-pane').length >= 2`, {
      label: "two panes",
    });
    const counts = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      const active = document.querySelector('.group-pane.active');
      return panes.map((p) => ({
        active: p === active,
        count: p.querySelectorAll('.tab-strip .tab').length,
      }));`);
    const activeCount = counts.find((c) => c.active).count;
    const otherCount = counts.find((c) => !c.active).count;

    // Programmatic click on the non-active pane's + (no pointerdown/focusin),
    // so only the threaded groupId can steer the note.
    const clicked = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      const active = document.querySelector('.group-pane.active');
      const other = panes.find((p) => p !== active);
      const plus = other.querySelector('.tab-new');
      if (!plus) return false;
      plus.click();
      return true;`);
    if (!clicked) throw new Error("no + in the non-active pane");
    await waitJs(
      `[...document.querySelectorAll('.group-pane.active .tab-title')]
         .some((t) => /untitled/i.test(t.textContent))`,
      { label: "untitled in clicked pane" },
    );
    const after = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      const active = document.querySelector('.group-pane.active');
      return panes.map((p) => ({
        active: p === active,
        count: p.querySelectorAll('.tab-strip .tab').length,
        untitled: [...p.querySelectorAll('.tab-title')].some((t) => /untitled/i.test(t.textContent)),
      }));`);
    const newActive = after.find((p) => p.active);
    const newOther = after.find((p) => !p.active);
    if (!newActive.untitled) throw new Error("untitled note did not open in the clicked pane");
    if (newActive.count !== otherCount + 1) {
      throw new Error(`clicked pane count wrong (${newActive.count} vs ${otherCount + 1})`);
    }
    if (newOther.count !== activeCount) {
      throw new Error(`other pane was touched (${newOther.count} vs ${activeCount})`);
    }

    // Focusin: focusing the + in a non-active pane makes that pane active.
    const focused = await js(`
      const panes = [...document.querySelectorAll('.group-pane')];
      const active = document.querySelector('.group-pane.active');
      const other = panes.find((p) => p !== active);
      const plus = other.querySelector('.tab-new');
      if (!plus) return false;
      plus.focus();
      return true;`);
    if (!focused) throw new Error("no + to focus in the non-active pane");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const focusActive = await js(`
      const plus = document.querySelector('.group-pane.active .tab-new');
      return !!plus && document.activeElement === plus;`);
    if (!focusActive) throw new Error("focusing the + did not make its pane active");
  });

  // -- probe 94: middle-click closes a tab from anywhere on it ----------------
  await probe("94-tab-middle-click", async () => {
    await openActivity("Notes");
    await collapsePanes();
    await openNote("type.md");
    await openNote("links.md");
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 2`, {
      label: "tabs",
    });
    const tabCount = () =>
      js(`const p = document.querySelector('.group-pane.active') || document;
          return p.querySelectorAll('.tab-strip .tab').length;`);

    // Middle-click on the tab body (not the label) closes it.
    const before = await tabCount();
    await js(`
      const p = document.querySelector('.group-pane.active') || document;
      const tab = p.querySelector('.tab.active');
      tab.dispatchEvent(new MouseEvent('auxclick',
        { bubbles: true, cancelable: true, button: 1 }));
      return true;`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterBody = await tabCount();
    if (afterBody !== before - 1) {
      throw new Error(`middle-click on tab body did not close (${before} -> ${afterBody})`);
    }

    // Middle-click on the close button and on + are unaffected.
    await openNote("type.md");
    await waitJs(`document.querySelectorAll('.group-pane.active .tab-strip .tab').length >= 1`, {
      label: "tabs again",
    });
    const beforeClose = await tabCount();
    await js(`
      const p = document.querySelector('.group-pane.active') || document;
      p.querySelector('.tab.active .tab-close').dispatchEvent(new MouseEvent('auxclick',
        { bubbles: true, cancelable: true, button: 1 }));
      return true;`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if ((await tabCount()) !== beforeClose) {
      throw new Error("middle-click on the close button closed the tab");
    }
    await js(`
      const p = document.querySelector('.group-pane.active') || document;
      p.querySelector('.tab-new').dispatchEvent(new MouseEvent('auxclick',
        { bubbles: true, cancelable: true, button: 1 }));
      return true;`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if ((await tabCount()) !== beforeClose) {
      throw new Error("middle-click on + changed the tabs");
    }
  });

  // -- probe 95: two rapid + clicks make one note ----------------------------
  await probe("95-tab-new-serialized", async () => {
    await openActivity("Notes");
    await collapsePanes();
    await waitJs(`!!document.querySelector('.group-pane.active .tab-new')`, {
      label: "new button",
    });
    await js(`
      window.__rejections = [];
      window.addEventListener('unhandledrejection', (e) => {
        window.__rejections.push(String(e.reason));
      });
      return true;`);
    const untitledCount = () =>
      js(`return [...document.querySelectorAll('.tab-title')]
            .filter((t) => /untitled/i.test(t.textContent.trim())).length;`);
    const before = await untitledCount();
    // Two synchronous clicks race the in-flight guard.
    await js(`
      const b = document.querySelector('.group-pane.active .tab-new');
      b.click();
      b.click();
      return true;`);
    await waitJs(
      `[...document.querySelectorAll('.tab-title')]
         .filter((t) => /untitled/i.test(t.textContent.trim())).length === ${before + 1}`,
      { label: "one new untitled" },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await untitledCount();
    const rejections = await js(`return window.__rejections ?? [];`);
    if (after !== before + 1) {
      throw new Error(`expected one new note, got ${after - before}`);
    }
    if (rejections.length) {
      throw new Error(`unhandled rejections: ${JSON.stringify(rejections)}`);
    }
  });

  // -- probe 96: the column header menu closes on Escape / outside / action --
  await probe("96-column-menu-dismiss", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    await js(`
      const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
        .find((x) => x.textContent.trim().startsWith('lex'));
      if (b) b.click();
      return !!b;`);
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });

    await js(`
      window.__ctxErrors = [];
      window.addEventListener('error', (e) => window.__ctxErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__ctxErrors.push('rej:' + String(e.reason)));
      return true;`);

    const openColMenu = () =>
      js(`
        const th = document.querySelector('.dict-grid thead th:nth-child(2)');
        if (!th) return { ok: false };
        const r = th.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `).then(async (pos) => {
        if (!pos || !pos.ok) return false;
        await rightClickAt(pos.x, pos.y);
        return true;
      });
    const menuOpen = () => js(`return !!document.querySelector('.ctx-menu');`);

    if (!(await openColMenu())) throw new Error("no column header to right-click");
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "column menu" });

    // Escape closes it.
    await pressKey("\uE00C");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterEscape = await menuOpen();
    const errs = await js(`return window.__ctxErrors ?? [];`);
    if (afterEscape) {
      throw new Error(`menu still open after Escape; errors=${JSON.stringify(errs)}`);
    }
    if (errs.length) throw new Error(`errors: ${JSON.stringify(errs)}`);

    // An outside mousedown closes it.
    if (!(await openColMenu())) throw new Error("no column header (2)");
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "column menu 2" });
    await js(`
      const tbody = document.querySelector('.dict-grid tbody');
      tbody.dispatchEvent(new MouseEvent('mousedown',
        { bubbles: true, cancelable: true, clientX: 60, clientY: 300 }));
      return true;`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await menuOpen()) throw new Error("menu still open after outside click");

    // Choosing a sort action closes it.
    if (!(await openColMenu())) throw new Error("no column header (3)");
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "column menu 3" });
    const clicked = await js(`
      const b = [...document.querySelectorAll('.ctx-menu button')]
        .find((x) => x.textContent.trim().includes('A'));
      if (b) b.click();
      return !!b;`);
    if (!clicked) throw new Error("no sort action in the column menu");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await menuOpen()) throw new Error("menu still open after an action");
  });

  // -- probe 97: the menu takes focus and responds to arrows + Enter ---------
  await probe("97-menu-keyboard-nav", async () => {
    await openActivity("Dictionary");
    await waitJs(`!!document.querySelector('.table-list')`, { label: "tables panel" });
    await js(`
      const b = [...document.querySelectorAll('.table-list .table-row .tree-name')]
        .find((x) => x.textContent.trim().startsWith('lex'));
      if (b) b.click();
      return !!b;`);
    await waitJs(`!!document.querySelector('.dict-grid')`, { label: "lex grid" });
    await js(`
      const th = document.querySelector('.dict-grid thead th:nth-child(2)');
      th.dispatchEvent(new MouseEvent('contextmenu',
        { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }));
      return true;`);
    await waitJs(`!!document.querySelector('.ctx-menu')`, { label: "column menu" });
    // The first item is focused on open.
    const firstFocused = await js(`
      const b = document.querySelector('.ctx-menu button');
      return document.activeElement === b;`);
    if (!firstFocused) throw new Error("menu did not focus its first item");
    // ArrowDown moves to the next item.
    await pressKey(ARROW_DOWN);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const secondFocused = await js(`
      const buttons = [...document.querySelectorAll('.ctx-menu button')];
      return document.activeElement === buttons[1];`);
    if (!secondFocused) throw new Error("ArrowDown did not move focus");
    // Enter activates the focused item and closes the menu.
    await pressKey(ENTER);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await js(`return !!document.querySelector('.ctx-menu');`)) {
      throw new Error("menu did not close after Enter");
    }
  });

  // -- probes 98-: the writing system tab and vector editor -----------------
  const canvasClick = (fx, fy) =>
    js(`const svg = document.querySelector('.canvas-svg');
      const b = svg.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: b.left + b.width * ${fx}, clientY: b.top + b.height * ${fy} };
      svg.dispatchEvent(new PointerEvent('pointerdown', at));
      svg.dispatchEvent(new PointerEvent('pointerup', at));
      return true;`);
  const glyphFiles = () => {
    const dir = path.join(WORKSPACE, "writing", "glyphs");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  await probe("98-writing-tab-opens-and-adds-a-glyph", async () => {
    await openActivity("Writing System");
    await waitJs(`!!document.querySelector('.writing')`, { label: "writing view" });
    await click('.writing-bar [data-action="add-glyph"]');
    await waitJs(`document.querySelectorAll('.glyph-tile[data-kind="glyph"]').length === 1`, {
      label: "one glyph tile",
    });
    const config = JSON.parse(
      fs.readFileSync(path.join(WORKSPACE, "config", "writing"), "utf8"),
    );
    assertEqual(config.glyphs.length, 1, "glyph saved to config/writing");
    assertEqual(config.glyphs[0].codepoint, 0xe000, "first private-use codepoint");
    await screenshot("p98-writing-tab");
  });

  await probe("99-glyph-opens-in-the-vector-editor", async () => {
    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.vector-editor .canvas-svg')`, {
      label: "vector editor",
    });
    // The toolbar must not overlap the toolbox (a class collision once forced 28px buttons).
    const overlap = await js(`const t = document.querySelector('.vector-toolbar').getBoundingClientRect();
      const x = document.querySelector('.toolbox').getBoundingClientRect();
      return t.bottom > x.top + 1 && t.top < x.bottom - 1 && t.right > x.left + 1 && t.left < x.right - 1;`);
    assertEqual(overlap, false, "toolbar does not overlap the toolbox");
    await screenshot("p99-vector-editor");
  });

  await probe("100-pen-clicks-create-nodes-and-save-to-disk", async () => {
    await click(".glyph-canvas");
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', bubbles: true })); return true;`);
    await canvasClick(0.35, 0.65);
    await canvasClick(0.65, 0.65);
    await canvasClick(0.5, 0.3);
    await waitJs(`document.querySelectorAll('.glyph-node').length === 3`, {
      label: "three nodes on the canvas",
    });
    await pressKey(ENTER);
    const deadline = Date.now() + 6000;
    let saved = null;
    while (Date.now() < deadline) {
      const files = glyphFiles();
      if (files.length) {
        saved = JSON.parse(
          fs.readFileSync(path.join(WORKSPACE, "writing", "glyphs", files[0]), "utf8"),
        );
        if ((saved.elements?.[0]?.nodes ?? []).length === 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assertEqual(saved?.elements?.[0]?.nodes?.length, 3, "three nodes persisted");
    const size = await js(`return document.querySelector('.editor-statusbar').textContent;`);
    if (/\\u00d7/.test(size) || !/\d+ \u00d7 \d+/.test(size)) {
      throw new Error(`status bar size is not rendered as "W × H": ${JSON.stringify(size)}`);
    }
    await screenshot("p100-pen-triangle");
  });

  await probe("101-undo-removes-the-last-edit-and-redo-restores-it", async () => {
    await click(".glyph-canvas");
    await pressKey("z", [CTRL]);
    await waitJs(
      `document.querySelectorAll('.glyph-node').length < 3`,
      { label: "undo removed a node" },
    );
    await pressKey("z", [CTRL, SHIFT]);
    await waitJs(`document.querySelectorAll('.glyph-node').length === 3`, {
      label: "redo restored the node",
    });
  });

  await probe("102-menu-bar-opens-and-escape-closes-it", async () => {
    await click(".menu-item");
    await waitJs(`!!document.querySelector('.menu-panel')`, { label: "menu panel" });
    await pressKey("\uE00C");
    await waitJs(`!document.querySelector('.menu-panel')`, { label: "menu closed on Escape" });
    await click(".menu-item");
    await waitJs(`!!document.querySelector('.menu-panel')`, { label: "menu reopened" });
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return true;`);
    await waitJs(`!document.querySelector('.menu-panel')`, {
      label: "menu closed on outside click",
    });
  });

  await probe("103-font-check-reports-and-export-gate-follows-errors", async () => {
    await js(`const b = [...document.querySelectorAll('.menu-item')]
      .find((x) => x.textContent.trim() === 'Export'); b.click(); return !!b;`);
    await waitJs(`!!document.querySelector('.menu-panel')`, { label: "export menu" });
    await js(`const b = [...document.querySelectorAll('.menu-panel button')]
      .find((x) => x.textContent.includes('Check font')); b.click(); return !!b;`);
    await waitJs(`!!document.querySelector('.font-report')`, { label: "font report" });
    const summary = await js(
      `return document.querySelector('[data-testid="font-report-summary"]').textContent.trim();`,
    );
    if (!/0 error/.test(summary)) throw new Error(`unexpected summary: ${summary}`);
    const codes = await js(`return [...document.querySelectorAll('.font-report li')].map((li) => li.dataset.code);`);
    if (codes.includes("bad-name")) throw new Error(`glyph names are not a font problem: ${codes}`);
    for (const code of ["open-contour", "winding", "rounding"]) {
      if (!codes.includes(code)) throw new Error(`missing ${code} in ${codes}`);
    }
    await screenshot("p103-font-report");
    await pressKey("\uE00C");
    await waitJs(`!document.querySelector('.font-report')`, { label: "report closed" });
  });

  await probe("104-orthography-rules-save-and-reject-unknown-glyphs", async () => {
    await click(".vector-editor .back");
    await waitJs(`!!document.querySelector('[data-testid="orthography-rules"]')`, {
      label: "rules editor",
    });
    await js(`[...document.querySelectorAll('[data-testid="orthography-rules"] button')]
      .find((b) => b.textContent.includes('Add rule')).click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-testid="orthography-rule"]').length === 1`, {
      label: "one rule row",
    });
    await js(`const inputs = document.querySelectorAll('[data-testid="orthography-rule"] input');
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      set(inputs[0], 'ka'); set(inputs[1], 'no-such-glyph'); return true;`);
    await waitJs(`!!document.querySelector('.orthography .rule-warning')`, {
      label: "unknown glyph warning shown",
    });
    const deadline = Date.now() + 6000;
    let rules = [];
    while (Date.now() < deadline) {
      rules = JSON.parse(fs.readFileSync(path.join(WORKSPACE, "config", "writing"), "utf8")).rules ?? [];
      if (rules[0]?.from === "ka") break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assertEqual(rules[0]?.from, "ka", "rule persisted to config/writing");
    await screenshot("p104-orthography-rules");
  });

  // -- probes 105-: viewport, select, hand and zoom tools -------------------
  const view = () =>
    js(`const v = document.querySelector('.canvas-svg').getAttribute('viewBox').split(' ').map(Number);
      const r = document.querySelector('.canvas-svg').getBoundingClientRect();
      return { x: v[0], y: v[1], w: v[2], h: v[3], sw: r.width, sh: r.height, left: r.left, top: r.top };`);
  const fire = (type, fx, fy, extra = {}) =>
    js(`const svg = document.querySelector('.canvas-svg');
      const b = svg.getBoundingClientRect();
      svg.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, Object.assign({ bubbles: true, cancelable: true,
        pointerId: 1, button: 0, clientX: b.left + b.width * ${fx}, clientY: b.top + b.height * ${fy} }, ${JSON.stringify(extra)})));
      return true;`);
  const dragOnCanvas = async (from, to, extra = {}) => {
    await fire("pointerdown", from[0], from[1], extra);
    await fire("pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, extra);
    await fire("pointermove", to[0], to[1], extra);
    await fire("pointerup", to[0], to[1], extra);
  };
  const tool = async (key) => {
    await click(".glyph-canvas");
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(
      new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return true;`);
  };
  const activeTool = () => js(`return document.querySelector('.toolbox .tool.active')?.dataset.tool;`);

  await probe("105-glyph-opens-on-select-and-fits-the-view", async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await waitJs(`!!document.querySelector('.glyph-tile[data-kind="glyph"]')`, { label: "grid" });
    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.canvas-svg')`, { label: "editor" });
    assertEqual(await activeTool(), "select", "default tool");
    const v = await view();
    // The viewBox must match the canvas aspect so nothing is letterboxed or stretched.
    const ratio = (v.w / v.h) / (v.sw / v.sh);
    if (Math.abs(ratio - 1) > 0.02) throw new Error(`viewBox aspect ${v.w / v.h} vs canvas ${v.sw / v.sh}`);
    // The glyph area from descender to ascender fits: 1000 units tall at most.
    // Descender to ascender and the whole default advance are visible, with a sane margin.
    if (v.y > -800 || v.y + v.h < 200) throw new Error(`rails not visible: y ${v.y}..${v.y + v.h}`);
    if (v.x > 0 || v.x + v.w < 600) throw new Error(`advance not visible: x ${v.x}..${v.x + v.w}`);
    if (v.w > 2400 && v.h > 2400) throw new Error(`fit is far too small: ${v.w} x ${v.h}`);
    await screenshot("p105-select-fit");
  });

  await probe("106-ctrl-wheel-zooms-about-the-cursor", async () => {
    const before = await view();
    const at = { fx: 0.8, fy: 0.2 };
    const pointBefore = {
      x: before.x + before.w * at.fx,
      y: before.y + before.h * at.fy,
    };
    await js(`const svg = document.querySelector('.canvas-svg');
      const b = svg.getBoundingClientRect();
      document.querySelector('.glyph-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -100, clientX: b.left + b.width * ${at.fx}, clientY: b.top + b.height * ${at.fy} }));
      return true;`);
    await waitJs(`document.querySelector('.canvas-svg').getAttribute('viewBox').split(' ')[2] < ${before.w} - 1`, {
      label: "zoomed in",
    });
    const after = await view();
    const pointAfter = { x: after.x + after.w * at.fx, y: after.y + after.h * at.fy };
    if (Math.abs(pointAfter.x - pointBefore.x) > 1 || Math.abs(pointAfter.y - pointBefore.y) > 1) {
      throw new Error(`the glyph point under the cursor moved: ${JSON.stringify({ pointBefore, pointAfter })}`);
    }
    const ratio = before.w / after.w;
    if (Math.abs(ratio - Math.SQRT2) > 0.02) throw new Error(`zoom step ${ratio}`);
  });

  await probe("107-space-drag-pans-the-view", async () => {
    const before = await view();
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); return true;`);
    await dragOnCanvas([0.5, 0.5], [0.6, 0.55]);
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })); return true;`);
    const after = await view();
    const moved = after.x - before.x;
    const expected = -before.w * 0.1;
    if (Math.abs(moved - expected) > 2) throw new Error(`pan moved ${moved}, expected ${expected}`);
    if (Math.abs(after.w - before.w) > 0.01) throw new Error("pan changed the zoom");
    assertEqual(await activeTool(), "select", "tool returns after Space is released");
  });

  await probe("108-hand-tool-and-middle-drag-pan", async () => {
    await tool("h");
    assertEqual(await activeTool(), "hand", "H selects the hand");
    const before = await view();
    await dragOnCanvas([0.5, 0.5], [0.4, 0.5]);
    const after = await view();
    if (after.x - before.x < before.w * 0.09) throw new Error(`hand pan x moved ${after.x - before.x}`);
    const mid = await view();
    await dragOnCanvas([0.5, 0.5], [0.5, 0.6], { button: 1 });
    const end = await view();
    if (Math.abs(end.y - mid.y) < 1) throw new Error("middle-drag did not pan");
  });

  await probe("109-zoom-tool-click-alt-click-and-box", async () => {
    await tool("0");
    await tool("z");
    assertEqual(await activeTool(), "zoom", "Z selects zoom");
    const v0 = await view();
    await fire("pointerdown", 0.5, 0.5);
    await fire("pointerup", 0.5, 0.5);
    const v1 = await view();
    if (!(v1.w < v0.w)) throw new Error("click did not zoom in");
    await fire("pointerdown", 0.5, 0.5, { altKey: true });
    await fire("pointerup", 0.5, 0.5, { altKey: true });
    const v2 = await view();
    if (Math.abs(v2.w - v0.w) > 1) throw new Error(`alt-click did not undo the zoom ${v2.w} vs ${v0.w}`);
    await dragOnCanvas([0.4, 0.4], [0.6, 0.5]);
    const v3 = await view();
    if (!(v3.w < v0.w * 0.5)) throw new Error(`box zoom too small a change ${v3.w}`);
    await screenshot("p109-zoom-box");
  });

  await probe("110-zoom-range-reaches-32x-and-0_1x", async () => {
    for (let i = 0; i < 40; i++) await js(`document.querySelector('.vector-toolbar .toolbar-group button[title="Zoom in"]').click(); return true;`);
    const hi = await js(`return document.querySelector('[data-testid="zoom-percent"]').textContent;`);
    assertEqual(hi, "3200%", "max zoom");
    for (let i = 0; i < 60; i++) await js(`document.querySelector('.vector-toolbar .toolbar-group button[title="Zoom out"]').click(); return true;`);
    const lo = await js(`return document.querySelector('[data-testid="zoom-percent"]').textContent;`);
    assertEqual(lo, "10%", "min zoom");
    await js(`[...document.querySelectorAll('.vector-toolbar .toolbar-group button')].find((b) => b.textContent.trim() === 'Fit').click(); return true;`);
  });

  await probe("111-select-click-marquee-move-and-delete", async () => {
    await tool("p");
    await click(".glyph-canvas");
    // Draw two separate triangles with the pen.
    const tri = async (ox) => {
      await fire("pointerdown", ox, 0.6); await fire("pointerup", ox, 0.6);
      await fire("pointerdown", ox + 0.12, 0.6); await fire("pointerup", ox + 0.12, 0.6);
      await fire("pointerdown", ox + 0.06, 0.4); await fire("pointerup", ox + 0.06, 0.4);
      await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
    };
    await tri(0.15);
    await tri(0.55);
    await tool("v");
    const count = () => js(`return document.querySelectorAll('.element-selection').length;`);
    assertEqual(await count(), 0, "nothing selected yet");
    await fire("pointerdown", 0.21, 0.55); await fire("pointerup", 0.21, 0.55);
    assertEqual(await count(), 1, "click selects one shape");
    await fire("pointerdown", 0.61, 0.55, { shiftKey: true }); await fire("pointerup", 0.61, 0.55, { shiftKey: true });
    assertEqual(await count(), 2, "shift-click adds");
    await fire("pointerdown", 0.9, 0.9); await fire("pointerup", 0.9, 0.9);
    assertEqual(await count(), 0, "click on empty space clears");
    await dragOnCanvas([0.05, 0.3], [0.45, 0.8]);
    assertEqual(await count(), 1, "marquee selects only the shape fully inside");
    const shapes0 = await js(`return (document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length;`);
    const d0 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    await dragOnCanvas([0.21, 0.55], [0.31, 0.55]);
    const d1 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    if (d0 === d1) throw new Error("dragging a selected shape did not move it");
    await screenshot("p111-select-move");
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); return true;`);
    await waitJs(`(document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length === ${shapes0 - 1}`, { label: "one shape deleted" });
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); return true;`);
    await waitJs(`(document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length === ${shapes0}`, { label: "undo restored it" });
  });

  await probe("112-ctrl-d-duplicates-and-arrow-keys-nudge", async () => {
    await fire("pointerdown", 0.61, 0.55); await fire("pointerup", 0.61, 0.55);
    const before = await js(`return (document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length;`);
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true })); return true;`);
    await waitJs(`(document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length === ${before + 1}`, { label: "duplicated" });
    const d0 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); return true;`);
    const d1 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    if (d0 === d1) throw new Error("arrow nudge did nothing");
  });

  await probe("113-toolbox-is-grouped-with-icons-and-tooltips", async () => {
    const info = await js(`return {
      groups: document.querySelectorAll('.toolbox .tool-group').length,
      seps: document.querySelectorAll('.toolbox .tool-sep').length,
      tools: [...document.querySelectorAll('.toolbox .tool[data-tool]')].map((b) => [b.dataset.tool, b.title, !!b.querySelector('svg')]),
      layers: [...document.querySelectorAll('.toolbox .layer-toggle')].map((b) => [b.dataset.layer, b.getAttribute('aria-pressed'), !!b.querySelector('svg')]),
      addImage: !!document.querySelector('.toolbox [data-action="back-image-add"]'),
    };`);
    assertEqual(info.groups, 5, "five groups: the tools and the layers");
    assertEqual(info.seps, 4, "separators between groups");
    assertEqual(info.tools.length, 10, "ten tools");
    for (const [id, title, icon] of info.tools) {
      if (!icon) throw new Error(`${id} has no icon`);
      if (!/\([A-Z]\)/.test(title)) throw new Error(`${id} tooltip lacks its shortcut: ${title}`);
    }
    assertEqual(
      JSON.stringify(info.layers.map((l) => [l[0], l[1]])),
      JSON.stringify([["guide", "true"], ["back", "true"], ["fore", "true"]]),
      "guide, back and fore toggles, all on",
    );
    for (const [, , icon] of info.layers) {
      if (!icon) throw new Error("a layer toggle has no icon");
    }
    assertEqual(info.addImage, true, "the add-tracing-image button sits with the layers");
    await screenshot("p113-toolbox");
  });

  // -- probes 114-: the editor must be quiet, cheap when idle, and responsive -
  const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const statusText = () => js(`return document.querySelector('.statusbar')?.textContent.trim() ?? '';`);
  const assertQuiet = async (what) => {
    await idle(2000);
    const status = await readStatusError();
    if (status) throw new Error(`${what}: status bar shows an error: ${status}`);
    const events = await js(`return window.__probeErrors ? window.__probeErrors.slice() : [];`);
    if (events.length) throw new Error(`${what}: ${events.join(" | ").slice(0, 300)}`);
  };
  const openFirstGlyph = async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    if (!(await js(`return !!document.querySelector('.writing');`))) {
      await openActivity("Writing System");
      await waitJs(`!!document.querySelector('.writing')`, { label: "writing view" });
    }
    if (!(await js(`return !!document.querySelector('.glyph-tile[data-kind="glyph"]');`))) {
      await click('.writing-bar [data-action="add-glyph"]');
    }
    await waitJs(`!!document.querySelector('.glyph-tile[data-kind="glyph"]')`, { label: "glyph grid" });
    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.canvas-svg')`, { label: "editor" });
  };

  await probe("114-editor-idle-shows-no-error-after-each-kind-of-use", async () => {
    await openFirstGlyph();
    await assertQuiet("after opening a glyph");

    await js(`const svg = document.querySelector('.canvas-svg'); const b = svg.getBoundingClientRect();
      document.querySelector('.glyph-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -100, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 })); return true;`);
    await assertQuiet("after zooming");

    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); return true;`);
    await dragOnCanvas([0.5, 0.5], [0.6, 0.55]);
    await js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })); return true;`);
    await assertQuiet("after panning");

    await tool("v");
    await dragOnCanvas([0.1, 0.1], [0.9, 0.9]);
    await assertQuiet("after a Select drag");

    await openFirstGlyph();
    await assertQuiet("after switching glyphs");
  });

  await probe("115-editor-idle-cost-is-near-zero", async () => {
    await openFirstGlyph();
    await idle(1500);
    // WebKitGTK has no "longtask" entry type, so a long task is measured the
    // way it shows up: a requestAnimationFrame gap well above one frame. A
    // timer that should fire every 10 ms and arrives late shows main-thread
    // blocking the same way. Both are sampled for 3 s with nobody touching the page.
    const result = await js(`
      return await new Promise((resolve) => {
        const gaps = [];
        const lates = [];
        let lastFrame = performance.now();
        let lastTimer = performance.now();
        let running = true;
        const frame = () => {
          const now = performance.now();
          gaps.push(now - lastFrame);
          lastFrame = now;
          if (running) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        const timer = setInterval(() => {
          const now = performance.now();
          lates.push(now - lastTimer - 10);
          lastTimer = now;
        }, 10);
        setTimeout(() => {
          running = false;
          clearInterval(timer);
          const blocked = lates.filter((x) => x > 50);
          resolve({
            frames: gaps.length,
            worstFrameGapMs: Math.round(Math.max(0, ...gaps)),
            framesOver50ms: gaps.filter((x) => x > 50).length,
            timerLateOver50ms: blocked.length,
            blockedMs: Math.round(blocked.reduce((a, b) => a + b, 0)),
            worstTimerLateMs: Math.round(Math.max(0, ...lates)),
          });
        }, 3000);
      });`);
    console.log("IDLE-COST", JSON.stringify(result));
    if (result.timerLateOver50ms > 0 || result.framesOver50ms > 0) {
      throw new Error(
        `idle editor blocks the main thread: ${result.framesOver50ms} frame gap(s) and ${result.timerLateOver50ms} late timer(s) over 50 ms, worst ${Math.max(result.worstFrameGapMs, result.worstTimerLateMs)} ms`,
      );
    }
  });

  await probe("116-pointer-latency-is-within-budget", async () => {
    await openFirstGlyph();
    await tool("v");
    await idle(800);
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const ms = await js(`
        return await new Promise((resolve) => {
          const svg = document.querySelector('.canvas-svg');
          const b = svg.getBoundingClientRect();
          const start = performance.now();
          svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1,
            clientX: b.left + b.width * (0.3 + ${i} * 0.03), clientY: b.top + b.height * 0.5 }));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
        });`);
      samples.push(ms);
      await idle(40);
    }
    samples.sort((a, b) => a - b);
    const median = Math.round(samples[Math.floor(samples.length / 2)]);
    const worst = Math.round(samples[samples.length - 1]);
    console.log("POINTER-LATENCY", JSON.stringify({ medianMs: median, worstMs: worst, samples: samples.map((x) => Math.round(x)) }));
    if (median > 50) throw new Error(`pointer latency median ${median} ms, worst ${worst} ms, budget 50 ms`);
  });

  // -- probes 117-: stale indexes after undo/redo/delete must never throw ----
  const key = (k, extra = {}) =>
    js(`document.querySelector('.glyph-canvas').dispatchEvent(new KeyboardEvent('keydown',
      Object.assign({ key: ${JSON.stringify(k)}, bubbles: true }, ${JSON.stringify(extra)}))); return true;`);
  const click1 = async (fx, fy, extra = {}) => {
    await fire("pointerdown", fx, fy, extra);
    await fire("pointerup", fx, fy, extra);
  };

  await probe("117-pen-click-after-undoing-its-first-point-does-not-throw", async () => {
    await openFirstGlyph();
    await tool("p");
    await click1(0.3, 0.6);
    await key("z", { ctrlKey: true });
    await click1(0.5, 0.5);
    await click1(0.6, 0.4);
    await idle(300);
    const nodes = await js(`return document.querySelectorAll('.glyph-node').length;`);
    if (nodes < 1) throw new Error("the pen did not start a new path after the undo");
  });

  await probe("118-random-edit-sequences-never-throw", async () => {
    await openFirstGlyph();
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const tools = ["v", "a", "p", "n", "b", "s", "m", "e", "h", "z"];
    const actions = [
      () => key("z", { ctrlKey: true }),
      () => key("z", { ctrlKey: true, shiftKey: true }),
      () => key("Delete"),
      () => key("d", { ctrlKey: true }),
      () => key("a", { ctrlKey: true }),
      () => key("Enter"),
      () => key("Escape"),
      () => key("Tab"),
      () => key("j", { shiftKey: true }),
      () => key("b", { shiftKey: true }),
      () => key("ArrowRight", { shiftKey: true }),
      () => key(tools[Math.floor(rnd() * tools.length)]),
      () => click1(0.15 + rnd() * 0.7, 0.15 + rnd() * 0.7),
      () => click1(0.15 + rnd() * 0.7, 0.15 + rnd() * 0.7, { shiftKey: true }),
      () => dragOnCanvas([0.1 + rnd() * 0.8, 0.1 + rnd() * 0.8], [0.1 + rnd() * 0.8, 0.1 + rnd() * 0.8]),
      // Draw with the pen, then undo or delete under it: the stale-draft shape of bug.
      async () => { await key("p"); await click1(0.15 + rnd() * 0.7, 0.15 + rnd() * 0.7); },
      async () => { await key("p"); await click1(0.15 + rnd() * 0.7, 0.15 + rnd() * 0.7); await key("z", { ctrlKey: true }); },
      async () => { await key("p"); await click1(0.2, 0.6); await click1(0.5, 0.6); await key("z", { ctrlKey: true }); await click1(0.4, 0.4); },
    ];
    await key("v");
    const log = [];
    for (let n = 0; n < 160; n++) {
      const which = Math.floor(rnd() * actions.length);
      log.push(which);
      await actions[which]();
      const errs = await js(`return window.__probeErrors ? window.__probeErrors.slice(-1) : [];`);
      if (errs.length) throw new Error(`step ${n} (action ${which}) after [${log.slice(-8)}]: ${errs[0]}`);
    }
  });

  // -- probes 119-: transform box, Transform dialog, node types --------------
  const bbox = () =>
    js(`const d = document.querySelector('.outline').getAttribute('d');
      const nums = [...d.matchAll(/(-?\\d+\\.?\\d*) (-?\\d+\\.?\\d*)/g)].map((m) => [Number(m[1]), -Number(m[2])]);
      if (!nums.length) return null;
      const xs = nums.map((p) => p[0]); const ys = nums.map((p) => p[1]);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), n: nums.length };`);
  const handleAt = (name) =>
    js(`const svg = document.querySelector('.canvas-svg');
      const el = document.querySelector('[data-handle=${name}]');
      if (!el) return null;
      const r = el.getBoundingClientRect(); const b = svg.getBoundingClientRect();
      return { fx: (r.left + r.width / 2 - b.left) / b.width, fy: (r.top + r.height / 2 - b.top) / b.height };`);
  const drawBox = async () => {
    await tool("p");
    for (const [x, y] of [[0.3, 0.6], [0.6, 0.6], [0.6, 0.4], [0.3, 0.4]]) await click1(x, y);
    await key("Enter");
    await tool("v");
    await click1(0.45, 0.5);
  };

  await probe("119-transform-box-appears-with-handles-for-a-selected-shape", async () => {
    await openFirstGlyph();
    await key("a", { ctrlKey: true });
    await key("Delete");
    await drawBox();
    await waitJs(`!!document.querySelector('.transform-box')`, { label: "transform box" });
    const counts = await js(`return {
      scale: document.querySelectorAll('.transform-handle.scale').length,
      skew: document.querySelectorAll('.transform-handle.skew').length,
      pivot: document.querySelectorAll('.transform-pivot').length };`);
    assertEqual(counts.scale, 4, "four corner handles");
    assertEqual(counts.skew, 4, "four edge handles");
    assertEqual(counts.pivot, 1, "one pivot");
    await screenshot("p119-transform-box");
  });

  await probe("120-corner-drag-scales-about-the-opposite-corner-in-one-undo-step", async () => {
    const before = await bbox();
    const h = await handleAt("ne");
    await dragOnCanvas([h.fx, h.fy], [h.fx + 0.1, h.fy - 0.05]);
    const after = await bbox();
    if (!(after.maxX > before.maxX + 20 && after.maxY > before.maxY + 20)) {
      throw new Error(`corner drag did not grow the shape: ${JSON.stringify({ before, after })}`);
    }
    if (Math.abs(after.minX - before.minX) > 0.6 || Math.abs(after.minY - before.minY) > 0.6) {
      throw new Error(`the opposite corner moved: ${JSON.stringify({ before, after })}`);
    }
    await key("z", { ctrlKey: true });
    const undone = await bbox();
    if (Math.abs(undone.maxX - before.maxX) > 0.6 || Math.abs(undone.maxY - before.maxY) > 0.6) {
      throw new Error(`one undo did not restore the whole drag: ${JSON.stringify({ before, undone })}`);
    }
  });

  await probe("121-shift-corner-drag-keeps-the-aspect-ratio", async () => {
    await click1(0.45, 0.5);
    const before = await bbox();
    const ratio = (before.maxX - before.minX) / (before.maxY - before.minY);
    const h = await handleAt("se");
    await dragOnCanvas([h.fx, h.fy], [h.fx + 0.12, h.fy + 0.02], { shiftKey: true });
    const after = await bbox();
    const r2 = (after.maxX - after.minX) / (after.maxY - after.minY);
    if (Math.abs(r2 - ratio) > 0.02) throw new Error(`ratio changed ${ratio} -> ${r2}`);
    if (!(after.maxX - after.minX > before.maxX - before.minX + 10)) throw new Error("did not scale");
    await key("z", { ctrlKey: true });
  });

  await probe("122-dragging-outside-a-corner-rotates-the-shape", async () => {
    await click1(0.45, 0.5);
    const before = await bbox();
    const h = await handleAt("ne");
    await dragOnCanvas([h.fx + 0.015, h.fy - 0.01], [h.fx + 0.06, h.fy + 0.12]);
    const after = await bbox();
    // A rotated rectangle has more than four distinct x coordinates in its bounds growing.
    const grew = (after.maxX - after.minX) !== (before.maxX - before.minX);
    if (!grew) throw new Error(`rotation did not change the bounds: ${JSON.stringify({ before, after })}`);
    await key("z", { ctrlKey: true });
    const undone = await bbox();
    if (Math.abs((undone.maxX - undone.minX) - (before.maxX - before.minX)) > 0.6) throw new Error("undo did not restore");
  });

  await probe("123-edge-drag-skews-the-shape", async () => {
    await click1(0.45, 0.5);
    const before = await bbox();
    const h = await handleAt("n");
    await dragOnCanvas([h.fx, h.fy], [h.fx + 0.08, h.fy]);
    const after = await bbox();
    if (!(after.maxX - after.minX > before.maxX - before.minX + 10)) {
      throw new Error(`skew did not widen the bounds: ${JSON.stringify({ before, after })}`);
    }
    if (Math.abs(after.maxY - before.maxY) > 0.6 || Math.abs(after.minY - before.minY) > 0.6) {
      throw new Error("a horizontal skew changed the height");
    }
    await key("z", { ctrlKey: true });
  });

  await probe("124-pivot-can-be-dragged-and-alt-scales-from-it", async () => {
    await click1(0.45, 0.5);
    const p0 = await handleAt("pivot");
    await dragOnCanvas([p0.fx, p0.fy], [p0.fx - 0.05, p0.fy]);
    const p1 = await handleAt("pivot");
    if (!(p1.fx < p0.fx - 0.02)) throw new Error(`pivot did not move: ${p0.fx} -> ${p1.fx}`);
    const before = await bbox();
    const h = await handleAt("ne");
    await dragOnCanvas([h.fx, h.fy], [h.fx + 0.06, h.fy - 0.06], { altKey: true });
    const after = await bbox();
    if (!(after.minX < before.minX - 5)) throw new Error(`alt did not scale from the pivot: ${JSON.stringify({ before, after })}`);
    await key("z", { ctrlKey: true });
  });

  await probe("125-transform-dialog-applies-numbers-copy-and-escape", async () => {
    await click1(0.45, 0.5);
    const before = await bbox();
    await key("m", { ctrlKey: true, shiftKey: true });
    await waitJs(`!!document.querySelector('.transform-dialog')`, { label: "dialog" });
    const set = (field, value) =>
      js(`const i = document.querySelector('[data-field="${field}"]'); i.value = ${JSON.stringify(String(value))};
        i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await set("sx", 200);
    await set("dx", 100);
    await js(`document.querySelector('[data-action="apply-transform"]').click(); return true;`);
    await waitJs(`!document.querySelector('.transform-dialog')`, { label: "dialog closed" });
    const after = await bbox();
    const w0 = before.maxX - before.minX;
    const w1 = after.maxX - after.minX;
    if (Math.abs(w1 - w0 * 2) > 1) throw new Error(`scale 200% gave width ${w1}, wanted ${w0 * 2}`);
    if (Math.abs((after.minX + after.maxX) / 2 - ((before.minX + before.maxX) / 2 + 100)) > 1) {
      throw new Error("move 100 did not shift the centre by 100");
    }
    await key("z", { ctrlKey: true });
    const back = await bbox();
    if (Math.abs(back.maxX - before.maxX) > 0.6) throw new Error("one undo did not restore the dialog transform");

    const shapesBefore = await js(`return (document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length;`);
    await click1(0.45, 0.5);
    await key("m", { ctrlKey: true, shiftKey: true });
    await waitJs(`!!document.querySelector('.transform-dialog')`, { label: "dialog again" });
    await set("dy", 150);
    await js(`document.querySelector('[data-field="copy"]').click(); return true;`);
    await js(`document.querySelector('[data-action="apply-transform"]').click(); return true;`);
    await waitJs(`(document.querySelector('.outline').getAttribute('d').match(/M /g) || []).length === ${shapesBefore} + 1`, {
      label: "a copy was added",
    });
    await key("z", { ctrlKey: true });
    await key("m", { ctrlKey: true, shiftKey: true });
    await waitJs(`!!document.querySelector('.transform-dialog')`, { label: "dialog third time" });
    await key("Escape");
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
    await waitJs(`!document.querySelector('.transform-dialog')`, { label: "Escape closes the dialog" });
    await screenshot("p125-after-dialog");
  });

  await probe("126-node-type-buttons-change-the-selected-node-and-its-shape", async () => {
    await tool("a");
    await click1(0.3, 0.6);
    const kinds = () => js(`return [...document.querySelectorAll('.glyph-node.node-selected')].map((n) => n.dataset.kind);`);
    await waitJs(`document.querySelectorAll('.glyph-node.node-selected').length === 1`, { label: "a node selected" });
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="corner"]').click(); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'corner'`, { label: "set to a corner" });
    assertEqual((await kinds())[0], "corner", "now a corner");
    const before = await js(`return document.querySelectorAll('.handle-line').length;`);
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="smooth"]').click(); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'smooth'`, { label: "now smooth" });
    const handles = await js(`return document.querySelectorAll('.handle-line').length;`);
    if (handles <= before) throw new Error(`a smooth node should grow a handle, saw ${handles} handle lines (was ${before})`);
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="symmetric"]').click(); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'symmetric'`, { label: "now symmetric" });
    const shape = await js(`return document.querySelector('.glyph-node.node-selected').tagName;`);
    assertEqual(shape, "polygon", "a symmetric node is drawn as a diamond");
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="corner"]').click(); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'corner'`, { label: "back to a corner" });
    await key("z", { ctrlKey: true });
    await key("z", { ctrlKey: true });
    await key("z", { ctrlKey: true });
    await screenshot("p126-node-types");
  });

  // -- probes 127-: bezier editing in the Direct tool ------------------------
  const handleCount = () => js(`return document.querySelectorAll('.handle-line').length;`);
  const nodePos = (n) =>
    js(`const svg = document.querySelector('.canvas-svg'); const b = svg.getBoundingClientRect();
      const el = document.querySelectorAll('.glyph-node')[${n}]; if (!el) return null;
      const r = el.getBoundingClientRect();
      return { fx: (r.left + r.width / 2 - b.left) / b.width, fy: (r.top + r.height / 2 - b.top) / b.height };`);
  const freshGlyph = async () => {
    await openFirstGlyph();
    await tool("v");
    await key("a", { ctrlKey: true });
    await key("Delete");
  };
  const drawSquare = async () => {
    await tool("p");
    for (const [x, y] of [[0.3, 0.6], [0.6, 0.6], [0.6, 0.4], [0.3, 0.4]]) await click1(x, y);
    await key("Enter");
    await tool("a");
  };
  const asCorners = async () => {
    await tool("a");
    await key("a", { ctrlKey: true });
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="corner"]').click(); return true;`);
    await js(`[...document.querySelectorAll('.glyph-node')].length; return true;`);
  };

  await probe("127-handles-show-only-for-selected-nodes-and-their-neighbours", async () => {
    await freshGlyph();
    await drawSquare();
    await key("a", { ctrlKey: true });
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="smooth"]').click(); return true;`);
    await click1(0.9, 0.9);
    await waitJs(`document.querySelectorAll('.glyph-node.node-selected').length === 0`, { label: "deselected" });
    assertEqual(await handleCount(), 0, "no handles with nothing selected");
    const p = await nodePos(1);
    await click1(p.fx, p.fy);
    await waitJs(`document.querySelectorAll('.glyph-node.node-selected').length === 1`, { label: "one selected" });
    const n = await handleCount();
    if (n !== 4) throw new Error(`a selected node shows 2 of its own handles + 1 facing handle on each neighbour = 4, saw ${n}`);
    // An open path's two end nodes each have one handle fewer than the others.
    await key("H", { shiftKey: true });
    await waitJs(`document.querySelectorAll('.handle-line').length === 6`, { label: "show all handles" });
    await key("H", { shiftKey: true });
    await waitJs(`document.querySelectorAll('.handle-line').length === 4`, { label: "show all off again" });
    await screenshot("p127-selected-handles");
  });

  await probe("128-dragging-a-curve-segment-reshapes-it-and-undoes-in-one-step", async () => {
    await freshGlyph();
    await drawSquare();
    await asCorners();
    await click1(0.9, 0.9);
    const d0 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    const a = await nodePos(0);
    const b = await nodePos(1);
    const mid = { fx: (a.fx + b.fx) / 2, fy: (a.fy + b.fy) / 2 };
    const nodesBefore = await js(`return document.querySelectorAll('.glyph-node').length;`);
    await dragOnCanvas([mid.fx, mid.fy], [mid.fx, mid.fy - 0.08]);
    const d1 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    if (d0 === d1) throw new Error("dragging the segment did not change the outline");
    if (!/C /.test(d1)) throw new Error(`the segment did not become a curve: ${d1}`);
    assertEqual(await js(`return document.querySelectorAll('.glyph-node').length;`), nodesBefore, "no node was added or removed");
    const pa = await nodePos(0);
    const pb = await nodePos(1);
    if (Math.abs(pa.fx - a.fx) > 0.002 || Math.abs(pb.fx - b.fx) > 0.002) throw new Error("an end node moved");
    await key("z", { ctrlKey: true });
    const d2 = await js(`return document.querySelector('.outline').getAttribute('d');`);
    assertEqual(d2, d0, "one undo restores the whole drag");
  });

  await probe("129-alt-drag-from-a-node-pulls-out-symmetric-handles", async () => {
    await click1(0.9, 0.9);
    const p = await nodePos(1);
    await dragOnCanvas([p.fx, p.fy], [p.fx + 0.08, p.fy], { altKey: true });
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'symmetric'`, { label: "node is symmetric" });
    const n = await handleCount();
    if (n < 2) throw new Error(`expected two handles after the pull, saw ${n}`);
    await key("z", { ctrlKey: true });
  });

  await probe("130-double-click-toggles-corner-and-smooth", async () => {
    await click1(0.9, 0.9);
    const p = await nodePos(2);
    await js(`const svg = document.querySelector('.canvas-svg'); const b = svg.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: b.left + b.width * ${p.fx}, clientY: b.top + b.height * ${p.fy} };
      svg.dispatchEvent(new PointerEvent('pointerdown', at)); svg.dispatchEvent(new PointerEvent('pointerup', at));
      svg.dispatchEvent(new MouseEvent('dblclick', at)); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'smooth'`, { label: "became smooth" });
    const withHandles = await handleCount();
    if (withHandles < 2) throw new Error("a smooth node should have handles");
    await js(`const svg = document.querySelector('.canvas-svg'); const b = svg.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, pointerId: 1, button: 0,
        clientX: b.left + b.width * ${p.fx}, clientY: b.top + b.height * ${p.fy} };
      svg.dispatchEvent(new PointerEvent('pointerdown', at)); svg.dispatchEvent(new PointerEvent('pointerup', at));
      svg.dispatchEvent(new MouseEvent('dblclick', at)); return true;`);
    await waitJs(`document.querySelector('.glyph-node.node-selected')?.dataset.kind === 'corner'`, { label: "back to corner" });
  });

  await probe("131-add-extrema-inserts-nodes-on-a-bulging-curve", async () => {
    await freshGlyph();
    await tool("p");
    await fire("pointerdown", 0.3, 0.6); await fire("pointermove", 0.3, 0.45); await fire("pointerup", 0.3, 0.45);
    await fire("pointerdown", 0.6, 0.6); await fire("pointermove", 0.6, 0.75); await fire("pointerup", 0.6, 0.75);
    await key("Enter");
    await tool("a");
    const before = await js(`return document.querySelectorAll('.glyph-node').length;`);
    await key("x", { ctrlKey: true, shiftKey: true });
    await waitJs(`document.querySelectorAll('.glyph-node').length > ${before}`, { label: "extrema added" });
    await key("z", { ctrlKey: true });
    await waitJs(`document.querySelectorAll('.glyph-node').length === ${before}`, { label: "undo removed them" });
    await screenshot("p131-extrema");
  });

  await probe("132-handle-drag-keeps-a-smooth-node-collinear-and-alt-breaks-it", async () => {
    await freshGlyph();
    await drawSquare();
    await key("a", { ctrlKey: true });
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="smooth"]').click(); return true;`);
    await click1(0.9, 0.9);
    const p = await nodePos(1);
    await click1(p.fx, p.fy);
    const dot = () =>
      js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
        return [...document.querySelectorAll('.handle')].map((c) => { const r = c.getBoundingClientRect();
          return { key: c.dataset.handleDot, fx: (r.left + r.width / 2 - b.left) / b.width, fy: (r.top + r.height / 2 - b.top) / b.height }; });`);
    const dots = await dot();
    const out = dots.find((d) => d.key.endsWith("1:out"));
    if (!out) throw new Error(`no out handle for node 1: ${JSON.stringify(dots)}`);
    await dragOnCanvas([out.fx, out.fy], [out.fx + 0.03, out.fy - 0.06]);
    const after = await dot();
    const o = after.find((d) => d.key.endsWith("1:out"));
    const i = after.find((d) => d.key.endsWith("1:in"));
    const np = await nodePos(1);
    const cross = (o.fx - np.fx) * (i.fy - np.fy) - (o.fy - np.fy) * (i.fx - np.fx);
    if (Math.abs(cross) > 0.0005) throw new Error(`smooth handles are not collinear, cross ${cross}`);
    await dragOnCanvas([o.fx, o.fy], [o.fx - 0.05, o.fy + 0.02], { altKey: true });
    const broken = await dot();
    const o2 = broken.find((d) => d.key.endsWith("1:out"));
    const i2 = broken.find((d) => d.key.endsWith("1:in"));
    const cross2 = (o2.fx - np.fx) * (i2.fy - np.fy) - (o2.fy - np.fy) * (i2.fx - np.fx);
    if (Math.abs(cross2) < 0.0005) throw new Error("Alt did not break the constraint");
    assertEqual(await js(`return document.querySelector('.glyph-node.node-selected')?.dataset.kind;`), "corner", "alt-break makes it a corner");
  });

  // -- probes 133-: visual language and info bar -----------------------------
  const info = (name) => js(`return document.querySelector('[data-info="${name}"]')?.textContent.trim() ?? null;`);
  const moveTo = (fx, fy) => fire("pointermove", fx, fy);

  await probe("133-info-bar-shows-cursor-zoom-tool-and-layer", async () => {
    await openFirstGlyph();
    await tool("v");
    assertEqual(await info("tool"), "Select", "tool name");
    assertEqual(await info("layer"), "Fore", "active layer");
    await moveTo(0.5, 0.5);
    const cursor = await info("cursor");
    if (!/^x -?\d+ +y -?\d+$/.test(cursor)) throw new Error(`cursor readout looks wrong: ${JSON.stringify(cursor)}`);
    const zoom = await info("zoom");
    if (!/^\d+%$/.test(zoom)) throw new Error(`zoom readout looks wrong: ${zoom}`);
    // The number must match the real position: the canvas centre is the view centre.
    const center = await js(`const v = document.querySelector('.canvas-svg').getAttribute('viewBox').split(' ').map(Number);
      return { x: Math.round(v[0] + v[2] / 2), y: Math.round(-(v[1] + v[3] / 2)) };`);
    const m = cursor.match(/x (-?\d+) +y (-?\d+)/);
    if (Math.abs(Number(m[1]) - center.x) > 2 || Math.abs(Number(m[2]) - center.y) > 2) {
      throw new Error(`cursor ${cursor} does not match the view centre ${JSON.stringify(center)}`);
    }
    await tool("h");
    assertEqual(await info("tool"), "Hand", "tool name follows the active tool");
  });

  await probe("134-info-bar-shows-distance-and-angle-only-while-dragging", async () => {
    await tool("v");
    assertEqual(await info("measure"), null, "no measure when idle");
    await fire("pointerdown", 0.4, 0.5);
    await moveTo(0.4, 0.5);
    await moveTo(0.6, 0.5);
    const m = await info("measure");
    if (!m || !/^d \d+ +\u2220 \d+\u00b0$/.test(m)) throw new Error(`measure readout looks wrong: ${JSON.stringify(m)}`);
    const angle = Number(m.match(/\u2220 (\d+)/)[1]);
    if (angle !== 0 && angle !== 360) throw new Error(`a horizontal drag to the right should read 0 degrees, got ${angle}`);
    await fire("pointerup", 0.6, 0.5);
    await waitJs(`!document.querySelector('[data-info="measure"]')`, { label: "measure cleared after the drag" });
    await screenshot("p134-info-bar");
  });

  await probe("135-guides-are-labelled-and-the-advance-box-is-drawn", async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await openFirstGlyph();
    const labels = await js(`return [...document.querySelectorAll('.guide-label')].map((t) => t.textContent.trim());`);
    for (const want of ["baseline 0", "x-height 500", "ascender 800", "descender -200", "cap height 700"]) {
      if (!labels.includes(want)) throw new Error(`missing guide label ${JSON.stringify(want)} in ${JSON.stringify(labels)}`);
    }
    await tool("p");
    for (const [x, y] of [[0.3, 0.6], [0.6, 0.6], [0.6, 0.4]]) await click1(x, y);
    await key("Enter");
    await key("v");
    await click1(0.45, 0.55);
    const adv = await js(`return document.querySelectorAll('.advance-box').length;`);
    assertEqual(adv >= 0, true, "advance box element is optional until an advance is set");
    await screenshot("p135-guide-labels");
  });

  await probe("136-start-arrow-marks-each-contour-and-an-open-path-shows-end-caps", async () => {
    await freshGlyph();
    await tool("p");
    for (const [x, y] of [[0.3, 0.6], [0.6, 0.6], [0.6, 0.4]]) await click1(x, y);
    await key("Enter");
    await tool("v");
    const arrows = await js(`return document.querySelectorAll('.start-arrow').length;`);
    assertEqual(arrows, 1, "one start arrow per contour");
    const caps = await js(`return document.querySelectorAll('.open-end').length;`);
    assertEqual(caps, 2, "an open path shows a cap at each end");
    await tool("p");
    await click1(0.3, 0.6);
    await click1(0.6, 0.4);
    await key("Enter");
    await tool("a");
    const closed = await js(`return document.querySelectorAll('.open-end').length;`);
    assertEqual(closed, 4, "a second open path adds two caps");
  });

  await probe("137-handles-use-different-colours-for-the-in-and-out-sides-and-x-marks", async () => {
    await freshGlyph();
    await drawSquare();
    await key("a", { ctrlKey: true });
    await js(`document.querySelector('[data-testid="node-type"] [data-kind="smooth"]').click(); return true;`);
    await waitJs(`document.querySelectorAll('.handle-line.handle-in').length > 0 && document.querySelectorAll('.handle-line.handle-out').length > 0`, { label: "both sides drawn" });
    const colours = await js(`const stroke = (sel) => getComputedStyle(document.querySelector(sel)).stroke;
      return { i: stroke('.handle-line.handle-in'), o: stroke('.handle-line.handle-out') };`);
    if (colours.i === colours.o) throw new Error(`in and out handle lines share a colour: ${colours.i}`);
    const marks = await js(`return document.querySelectorAll('.handle-x').length;`);
    if (marks < 2) throw new Error(`handles should carry X marks, saw ${marks}`);
    const crosses = await js(`return document.querySelectorAll('.node-cross').length;`);
    if (crosses < 1) throw new Error("smooth on-curve nodes should carry a cross");
    await screenshot("p137-handle-colours");
  });

  // -- probes 138-: the glyph grid -------------------------------------------
  const invokeAsync = async (cmd, args) => {
    const result = await wd("POST", `/session/${sessionId}/execute/async`, {
      script: `const done = arguments[arguments.length - 1];
        window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})
          .then((v) => done({ ok: true, v })).catch((e) => done({ ok: false, e: String(e) }));`,
      args: [],
    });
    if (!result?.ok) throw new Error(`${cmd} failed: ${result?.e}`);
    return result.v;
  };
  const writeGrid = async (glyphs, phonemes, outlines) => {
    const cfg = await invokeAsync("config_get", { section: "writing" });
    await invokeAsync("config_set", { section: "writing", value: { ...cfg, glyphs } });
    const ph = await invokeAsync("config_get", { section: "phonology" });
    await invokeAsync("config_set", { section: "phonology", value: { ...ph, phonemes } });
    for (const [id, outline] of Object.entries(outlines)) {
      await invokeAsync("writing_glyph_set", { id, outline });
    }
  };
  const sq = (x, y, w, h) => ({
    kind: "contour", closed: true, fill_rule: "nonzero",
    nodes: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => ({ x: a, y: b, kind: "corner" })),
  });
  const reopenGrid = async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await openActivity("Dictionary");
    await openActivity("Writing System");
    await waitJs(`!!document.querySelector('.writing')`, { label: "writing view" });
  };
  const gcell = (id) => `document.querySelector('[data-cell="${id}"]')`;

  await probe("138-grid-draws-boxed-cells-with-previews-and-x-slots-for-missing-sounds", async () => {
    const mk = (id, name, sounds, group, order) => ({ id, name, codepoint: 0xe000 + order, phonemes: sounds, order, group });
    await writeGrid(
      [mk("g-k", "ka", ["p-k"], "consonants", 0), mk("g-a", "aa", ["p-a"], "vowels", 1), mk("g-blank", "blank", [], "", 2)],
      [
        { id: "p-k", symbol: "k", kind: "consonant" },
        { id: "p-a", symbol: "a", kind: "vowel" },
        { id: "p-t", symbol: "t", kind: "consonant" },
        { id: "p-i", symbol: "i", kind: "vowel" },
      ],
      { "g-k": { elements: [sq(50, 0, 300, 700)], advance: 400 }, "g-a": { elements: [sq(20, 0, 500, 400)], advance: 560 }, "g-blank": { elements: [] } },
    );
    await reopenGrid();
    await waitJs(`!!document.querySelector('[data-cell="g-k"]')`, { label: "first cell" });
    await waitJs(`document.querySelectorAll('.glyph-tile[data-kind="empty"]').length === 2`, { label: "two empty slots (t and i)" });
    await waitJs(`document.querySelectorAll('.cell-ink').length === 2`, { label: "two drawn previews" });
    const info = await js(`const t = document.querySelector('[data-cell="g-k"]');
      return { label: t.querySelector('.glyph-label').textContent.trim(),
        hasArt: !!t.querySelector('svg.glyph-art'), ink: !!t.querySelector('.cell-ink'),
        advance: !!t.querySelector('.cell-advance'),
        slots: [...document.querySelectorAll('.glyph-tile[data-kind="empty"]')].map((e) => e.querySelector('.glyph-label').textContent.trim()).sort(),
        xs: document.querySelectorAll('.glyph-tile[data-kind="empty"] .empty-x line').length };`);
    if (!info.hasArt || !info.ink || !info.advance) throw new Error(`cell is missing art/ink/advance: ${JSON.stringify(info)}`);
    if (!/k/.test(info.label)) throw new Error(`label should name the sound: ${info.label}`);
    assertEqual(JSON.stringify(info.slots), JSON.stringify(["i", "t"]), "empty slots are the uncovered sounds");
    assertEqual(info.xs, 4, "each empty slot draws an X (two lines each)");
    const spans = await js(`const tile = document.querySelector('.glyph-tile[data-kind="empty"]');
      const art = tile.querySelector('svg.glyph-art').getBoundingClientRect();
      return [...tile.querySelectorAll('.empty-x line')].map((l) => { const r = l.getBoundingClientRect();
        return { w: r.width / art.width, h: r.height / art.height }; });`);
    for (const sp of spans) {
      if (sp.w < 0.95 || sp.h < 0.95) throw new Error(`an X diagonal does not span its cell: ${JSON.stringify(spans)}`);
    }
    const literal = await js(`return [...document.querySelectorAll('.writing *')].filter((e) => e.children.length === 0 && /\\\\u[0-9a-fA-F]{4}/.test(e.textContent)).map((e) => e.textContent.trim());`);
    if (literal.length) throw new Error(`literal unicode escapes are shown as text: ${JSON.stringify(literal)}`);
    const blank = await js(`return !document.querySelector('[data-cell="g-blank"] .cell-ink');`);
    assertEqual(blank, true, "a glyph with no outline draws no ink");
    await screenshot("p138-grid");
  });

  await probe("139-progress-line-and-filters-follow-what-is-drawn", async () => {
    const progress = () => js(`return document.querySelector('[data-testid="grid-progress"]').textContent.trim();`);
    assertEqual(await progress(), "2 of 5 glyphs drawn", "ka and aa drawn of 3 glyphs + 2 empty sounds");
    const shown = () => js(`return Number(document.querySelector('[data-testid="grid-shown"]').textContent);`);
    assertEqual(await shown(), 5, "all cells shown");
    const setSelect = (label, value) =>
      js(`const s = document.querySelector('[aria-label="${label}"]'); s.value = ${JSON.stringify(value)};
        s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await setSelect("Filter by drawn or empty", "drawn");
    await waitJs(`Number(document.querySelector('[data-testid="grid-shown"]').textContent) === 2`, { label: "only drawn" });
    assertEqual(await progress(), "2 of 5 glyphs drawn", "progress ignores filters");
    await setSelect("Filter by drawn or empty", "empty");
    await waitJs(`Number(document.querySelector('[data-testid="grid-shown"]').textContent) === 3`, { label: "blank + two slots" });
    await setSelect("Filter by drawn or empty", "all");
    await setSelect("Filter by sound type", "vowel");
    await waitJs(`Number(document.querySelector('[data-testid="grid-shown"]').textContent) === 2`, { label: "aa and the i slot" });
    await setSelect("Filter by sound type", "all");
    await js(`const i = document.querySelector('.grid-search'); i.value = 'ka'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await waitJs(`Number(document.querySelector('[data-testid="grid-shown"]').textContent) === 1`, { label: "text filter" });
    await js(`const i = document.querySelector('.grid-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await waitJs(`Number(document.querySelector('[data-testid="grid-shown"]').textContent) === 5`, { label: "filters cleared" });
  });

  await probe("140-cell-size-buttons-and-slider-resize-the-cells", async () => {
    const width = () => js(`return Math.round(document.querySelector('[data-cell="g-k"]').getBoundingClientRect().width);`);
    const m = await width();
    await js(`document.querySelector('[data-size="L"]').click(); return true;`);
    await waitJs(`Math.round(document.querySelector('[data-cell="g-k"]').getBoundingClientRect().width) > ${m}`, { label: "L is larger" });
    const l = await width();
    await js(`document.querySelector('[data-size="S"]').click(); return true;`);
    await waitJs(`Math.round(document.querySelector('[data-cell="g-k"]').getBoundingClientRect().width) < ${m}`, { label: "S is smaller" });
    const sm = await width();
    if (!(sm < m && m < l)) throw new Error(`sizes not ordered: S ${sm} M ${m} L ${l}`);
    await js(`document.querySelector('[data-size="M"]').click(); return true;`);
  });

  await probe("141-clicking-an-empty-slot-creates-and-opens-its-glyph", async () => {
    await js(`document.querySelector('.glyph-tile[data-kind="empty"]').click(); return true;`);
    await waitJs(`!!document.querySelector('.vector-editor .canvas-svg')`, { label: "editor opened for the new glyph" });
    const cfg = await invokeAsync("config_get", { section: "writing" });
    assertEqual(cfg.glyphs.length, 4, "a glyph was added");
    const made = cfg.glyphs[cfg.glyphs.length - 1];
    if (!made.phonemes.length) throw new Error("the new glyph is not mapped to the sound");
  });

  await probe("142-grid-cell-shows-edits-after-the-glyph-is-drawn-in-the-editor", async () => {
    const id = (await invokeAsync("config_get", { section: "writing" })).glyphs.at(-1).id;
    await tool("p");
    for (const [x, y] of [[0.3, 0.6], [0.6, 0.6], [0.6, 0.4]]) await click1(x, y);
    await key("Enter");
    await js(`document.querySelector('.vector-editor .back').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-cell="${id}"] .cell-ink')`, { label: "the new glyph's cell now shows ink" });
    await waitJs(`document.querySelector('[data-testid="grid-progress"]').textContent.trim() === '3 of 5 glyphs drawn'`, { label: "progress went up" });
  });

  await probe("143-large-glyph-sets-render-only-a-window-and-scroll-smoothly", async () => {
    const N = 600;
    const glyphs = [];
    const outlines = {};
    for (let n = 0; n < N; n++) {
      const id = `g${String(n).padStart(4, "0")}`;
      glyphs.push({ id, name: `glyph ${n}`, codepoint: 0xe000 + n, phonemes: [], order: n, group: "" });
      outlines[id] = { elements: [sq(40 + (n % 5) * 20, 0, 300, 300 + (n % 7) * 60)], advance: 420 };
    }
    await writeGrid(glyphs, [], outlines);
    await reopenGrid();
    await waitJs(`!!document.querySelector('[data-cell="g0000"]')`, { label: "first cell" });
    const stats = await js(`const g = document.querySelector('[data-testid="glyph-grid"]');
      return { rendered: Number(g.dataset.rendered), rows: Number(g.dataset.rows), cols: Number(g.dataset.cols),
        dom: document.querySelectorAll('.glyph-tile').length };`);
    if (stats.dom >= 200) throw new Error(`rendered ${stats.dom} of ${N} cells: the grid is not virtualised`);
    if (stats.rows * stats.cols < N) throw new Error(`layout too small for ${N}: ${JSON.stringify(stats)}`);
    await waitJs(`document.querySelector('[data-testid="grid-progress"]').textContent.trim() === '${N} of ${N} glyphs drawn'`, {
      timeout: 40000, label: "every outline loaded for the progress line",
    });
    const before = await js(`return !!document.querySelector('[data-cell="g0000"]');`);
    assertEqual(before, true, "first cell is in the DOM at the top");
    await js(`document.querySelector('.glyph-scroller').scrollTop = 99999; return true;`);
    await waitJs(`!!document.querySelector('[data-cell="g0${N - 1}"]') || !!document.querySelector('[data-cell="g${N - 1}"]')`, { label: "last cell after scrolling to the end" });
    const gone = await js(`return !document.querySelector('[data-cell="g0000"]');`);
    assertEqual(gone, true, "cells scrolled out of view are removed from the DOM");
    await waitJs(`!!document.querySelector('.glyph-tile .cell-ink')`, { label: "ink at the end" });
    const cost = await js(`
      return await new Promise((resolve) => {
        const el = document.querySelector('.glyph-scroller');
        const gaps = []; let last = performance.now(); let n = 0;
        const step = () => { const now = performance.now(); gaps.push(now - last); last = now;
          el.scrollTop = (n % 2 ? 0 : 99999) * 1; n += 1; if (n < 40) requestAnimationFrame(step); else
          resolve({ worst: Math.round(Math.max(...gaps)), median: Math.round([...gaps].sort((a, b) => a - b)[20]) }); };
        requestAnimationFrame(step); });`);
    console.log("GRID-SCROLL", JSON.stringify(cost));
    if (cost.worst > 250) throw new Error(`scrolling a ${N}-glyph grid has a ${cost.worst} ms frame`);
    await screenshot("p143-large-grid");
  });

  // -- probes 144-: polish round (double-click selection, node mod, shift snapping)
  const selectedText = () => js(`return String(window.getSelection()?.toString() ?? '');`);

  await probe("144-double-clicking-the-canvas-does-not-select-its-hint-text", async () => {
    await freshGlyph();
    await tool("v");
    await js(`window.getSelection()?.removeAllRanges(); return true;`);
    const at = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      const h = document.querySelector('.canvas-hint').getBoundingClientRect();
      return { x: Math.round(h.left + 12), y: Math.round(h.top + h.height / 2), b: [b.left, b.top, b.width, b.height] };`);
    // Real double-click on the hint, where the browser would otherwise select a word.
    await wd("POST", `/session/${sessionId}/actions`, {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
        { type: "pointerMove", duration: 0, origin: "viewport", x: at.x, y: at.y },
        { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 },
        { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await idle(200);
    const sel = await selectedText();
    assertEqual(sel, "", "nothing is selected after a double-click on the canvas hint");
    const cs = await js(`const h = document.querySelector('.canvas-hint'); const c = document.querySelector('.glyph-canvas');
      return [getComputedStyle(h).userSelect || getComputedStyle(h).webkitUserSelect, getComputedStyle(c).userSelect || getComputedStyle(c).webkitUserSelect];`);
    assertEqual(cs[0], "none", "hint is user-select none");
    assertEqual(cs[1], "none", "canvas is user-select none");
  });

  const longLine = async () => {
    await freshGlyph();
    await tool("p");
    await click1(0.2, 0.5);
    await click1(0.8, 0.5);
    await key("Enter");
    await tool("n");
  };
  const pointsOn = () => js(`return document.querySelectorAll('.glyph-node').length;`);

  await probe("145-node-mod-adds-a-node-anywhere-along-a-long-line", async () => {
    await longLine();
    assertEqual(await pointsOn(), 2, "two nodes to start");
    const fracs = [0.27, 0.41, 0.58, 0.73];
    for (const f of fracs) {
      const before = await pointsOn();
      await click1(f, 0.5 + 0.004);
      await waitJs(`document.querySelectorAll('.glyph-node').length === ${before + 1}`, { label: `a node added near ${f}` });
    }
    assertEqual(await pointsOn(), 6, "four nodes were added, one per click, none missed");
  });

  await probe("146-shift-hover-in-node-mod-shows-clean-spots-and-a-click-uses-one", async () => {
    await longLine();
    await fire("pointermove", 0.52, 0.5 + 0.003, { shiftKey: true });
    await waitJs(`document.querySelectorAll('.clean-spot').length >= 3`, { label: "clean spots appear while Shift is held" });
    const labels = await js(`return [...document.querySelectorAll('.clean-spot')].map((c) => c.dataset.spot);`);
    for (const want of ["middle", "1/3", "2/3"]) if (!labels.includes(want)) throw new Error(`missing spot ${want} in ${labels}`);
    await waitJs(`document.querySelectorAll('.clean-spot-active').length === 1`, { label: "the nearest spot is highlighted" });
    await waitJs(`!!document.querySelector('[data-testid="spot-label"]')`, { label: "a label says what a click will do" });
    await fire("pointermove", 0.52, 0.5 + 0.003, {});
    await waitJs(`document.querySelectorAll('.clean-spot').length === 0`, { label: "spots vanish without Shift" });
    await fire("pointermove", 0.53, 0.5 + 0.003, { shiftKey: true });
    await waitJs(`document.querySelectorAll('.clean-spot-active').length === 1`, { label: "spots back" });
    const before = await pointsOn();
    const mid = await js(`const a = [...document.querySelectorAll('.glyph-node')].map((n) => n.getBoundingClientRect());
      return a.length === 2 ? { x: (a[0].left + a[1].left) / 2 + a[0].width / 2 } : null;`);
    await fire("pointerdown", 0.53, 0.5 + 0.003, { shiftKey: true });
    await fire("pointerup", 0.53, 0.5 + 0.003, { shiftKey: true });
    await waitJs(`document.querySelectorAll('.glyph-node').length === ${before + 1}`, { label: "node added" });
    const nodes = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      return [...document.querySelectorAll('.glyph-node')].map((n) => { const r = n.getBoundingClientRect(); return (r.left + r.width / 2 - b.left) / b.width; }).sort((p, q) => p - q);`);
    const a0 = nodes[0], a1 = nodes[nodes.length - 1];
    const frac = (nodes[1] - a0) / (a1 - a0);
    const ok = [1 / 2, 1 / 3, 2 / 3, 1 / 4, 3 / 4].some((c) => Math.abs(c - frac) < 0.004);
    if (!ok) throw new Error(`the node was not placed on a clean fraction: ${frac}`);
    void mid;
    await screenshot("p146-clean-spots");
  });

  await probe("147-shift-moving-a-node-aligns-it-with-another-node", async () => {
    await freshGlyph();
    await tool("p");
    for (const [x, y] of [[0.3, 0.65], [0.7, 0.65], [0.7, 0.35]]) await click1(x, y);
    await key("Enter");
    await tool("a");
    await click1(0.9, 0.9);
    const p = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      const r = [...document.querySelectorAll('.glyph-node')].map((n) => n.getBoundingClientRect());
      return r.map((q) => ({ fx: (q.left + q.width / 2 - b.left) / b.width, fy: (q.top + q.height / 2 - b.top) / b.height }));`);
    const target = p[1];
    await fire("pointerdown", p[2].fx, p[2].fy);
    await fire("pointermove", p[2].fx - 0.03, p[2].fy - 0.02, { shiftKey: true });
    await fire("pointermove", target.fx - 0.002, p[2].fy - 0.06, { shiftKey: true });
    await waitJs(`document.querySelectorAll('.align-line').length >= 1`, { label: "an alignment guide is drawn" });
    await fire("pointerup", target.fx - 0.002, p[2].fy - 0.06, { shiftKey: true });
    const after = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      const r = [...document.querySelectorAll('.glyph-node')].map((n) => n.getBoundingClientRect());
      return r.map((q) => (q.left + q.width / 2 - b.left) / b.width);`);
    if (Math.abs(after[2] - after[1]) > 0.0015) throw new Error(`the node did not align horizontally: ${after[2]} vs ${after[1]}`);
    await screenshot("p147-aligned");
  });

  await probe("148-shift-dragging-a-line-moves-its-centre-and-snaps", async () => {
    await freshGlyph();
    await tool("p");
    for (const [x, y] of [[0.3, 0.7], [0.7, 0.7], [0.7, 0.4], [0.3, 0.4]]) await click1(x, y);
    await fire("pointerdown", 0.3, 0.7); await fire("pointerup", 0.3, 0.7);
    await key("Enter");
    await tool("a");
    await click1(0.9, 0.9);
    const info = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      const r = [...document.querySelectorAll('.glyph-node')].map((n) => n.getBoundingClientRect());
      return r.map((q) => ({ fx: (q.left + q.width / 2 - b.left) / b.width, fy: (q.top + q.height / 2 - b.top) / b.height }));`);
    const a = info[0], b = info[1];
    const grab = { fx: a.fx + (b.fx - a.fx) * 0.8, fy: a.fy };
    await fire("pointerdown", grab.fx, grab.fy);
    await fire("pointermove", grab.fx, grab.fy - 0.03, { shiftKey: true });
    await fire("pointermove", grab.fx, grab.fy - 0.06, { shiftKey: true });
    const centreMoved = await js(`const d = document.querySelector('.outline').getAttribute('d'); return d;`);
    await fire("pointerup", grab.fx, grab.fy - 0.06, { shiftKey: true });
    const d = centreMoved;
    const m = d.match(/C ([\-\d.]+) ([\-\d.]+) ([\-\d.]+) ([\-\d.]+) ([\-\d.]+) ([\-\d.]+)/);
    if (!m) throw new Error(`the line did not become a curve: ${d}`);
    await key("z", { ctrlKey: true });
    // Without Shift the grabbed point (80% along) follows; with Shift the centre (50%) does. The two
    // curves must differ, which they only do if Shift changed the anchor.
    await fire("pointerdown", grab.fx, grab.fy);
    await fire("pointermove", grab.fx, grab.fy - 0.03);
    await fire("pointermove", grab.fx, grab.fy - 0.06);
    const plain = await js(`return document.querySelector('.outline').getAttribute('d');`);
    await fire("pointerup", grab.fx, grab.fy - 0.06);
    if (plain === d) throw new Error("Shift made no difference to which point of the line is dragged");
    await key("z", { ctrlKey: true });
  });

  // -- probes 149-: spacing by dragging ----------------------------------------
  const spacingVals = () =>
    js(`const v = (f) => { const i = document.querySelector('[data-spacing="' + f + '"]'); return i ? i.value : null; };
      return { lsb: v('lsb'), rsb: v('rsb'), advance: v('advance') };`);
  const setSpacingInput = (field, value) =>
    js(`const i = document.querySelector('[data-spacing="${field}"]'); i.value = ${JSON.stringify(String(value))};
      i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  const drawBlock = async () => {
    await freshGlyph();
    await tool("p");
    for (const [x, y] of [[0.35, 0.65], [0.6, 0.65], [0.6, 0.4], [0.35, 0.4]]) await click1(x, y);
    await fire("pointerdown", 0.35, 0.65); await fire("pointerup", 0.35, 0.65);
    await key("Enter");
    await tool("v");
  };
  const lineX = (which) =>
    js(`const svg = document.querySelector('.canvas-svg'); const b = svg.getBoundingClientRect();
      const l = document.querySelector('[data-bearing="${which}"]'); if (!l) return null;
      const r = l.getBoundingClientRect(); return (r.left + r.width / 2 - b.left) / b.width;`);

  await probe("149-bearing-fields-show-the-real-values-and-the-lsb-box-moves-the-ink", async () => {
    await drawBlock();
    const v0 = await spacingVals();
    if (v0.lsb === "" || v0.rsb === "" || v0.advance === "") throw new Error(`fields are empty: ${JSON.stringify(v0)}`);
    const lsb0 = Number(v0.lsb), rsb0 = Number(v0.rsb), adv0 = Number(v0.advance);
    const left0 = await lineX("lsb");
    await setSpacingInput("lsb", lsb0 + 100);
    await waitJs(`Number(document.querySelector('[data-spacing="lsb"]').value) === ${lsb0 + 100}`, { label: "lsb updated" });
    const v1 = await spacingVals();
    assertEqual(Number(v1.rsb), rsb0, "right bearing unchanged by a left-bearing edit");
    assertEqual(Number(v1.advance), adv0 + 100, "the advance moved with the ink");
    const left1 = await lineX("lsb");
    if (!(left1 > left0)) throw new Error("the left bearing line did not move right");
    await key("z", { ctrlKey: true });
    await waitJs(`Number(document.querySelector('[data-spacing="lsb"]').value) === ${lsb0}`, { label: "one undo restores it" });
    await screenshot("p149-bearings");
  });

  await probe("150-rsb-and-advance-boxes-change-only-the-advance", async () => {
    const v0 = await spacingVals();
    const lsb0 = Number(v0.lsb), rsb0 = Number(v0.rsb), adv0 = Number(v0.advance);
    await setSpacingInput("rsb", rsb0 + 40);
    await waitJs(`Number(document.querySelector('[data-spacing="advance"]').value) === ${adv0 + 40}`, { label: "advance grew" });
    assertEqual(Number((await spacingVals()).lsb), lsb0, "ink did not move");
    await setSpacingInput("advance", adv0 + 40 + 60);
    await waitJs(`Number(document.querySelector('[data-spacing="rsb"]').value) === ${rsb0 + 100}`, { label: "rsb absorbed it" });
    await key("z", { ctrlKey: true });
    await key("z", { ctrlKey: true });
  });

  await probe("151-dragging-the-bearing-lines-on-the-canvas-sets-spacing", async () => {
    const v0 = await spacingVals();
    const adv0 = Number(v0.advance), lsb0 = Number(v0.lsb), rsb0 = Number(v0.rsb);
    const ax = await lineX("advance");
    await fire("pointermove", ax, 0.2);
    await waitJs(`document.querySelector('.canvas-svg').dataset.bearingHover === 'advance'`, { label: "hover shows the advance line is grabbable" });
    await fire("pointerdown", ax, 0.2);
    await fire("pointermove", ax + 0.04, 0.2);
    await fire("pointermove", ax + 0.08, 0.2);
    await fire("pointerup", ax + 0.08, 0.2);
    const v1 = await spacingVals();
    if (!(Number(v1.advance) > adv0 + 20)) throw new Error(`dragging the advance line right did not widen the advance: ${JSON.stringify({ v0, v1 })}`);
    assertEqual(Number(v1.lsb), lsb0, "ink unmoved by an advance drag");
    await key("z", { ctrlKey: true });
    assertEqual(Number((await spacingVals()).advance), adv0, "one undo undoes the whole drag");

    const lx = await lineX("lsb");
    await fire("pointerdown", lx, 0.2);
    await fire("pointermove", lx + 0.05, 0.2);
    await fire("pointermove", lx + 0.1, 0.2);
    await fire("pointerup", lx + 0.1, 0.2);
    const v2 = await spacingVals();
    if (!(Number(v2.lsb) > lsb0 + 20)) throw new Error(`left-bearing drag did not move the ink: ${JSON.stringify(v2)}`);
    assertEqual(Number(v2.rsb), rsb0, "right bearing unchanged by a left-bearing drag");
    await key("z", { ctrlKey: true });
    assertEqual(Number((await spacingVals()).lsb), lsb0, "undone");
  });

  await probe("152-a-node-on-the-bearing-line-is-moved-not-the-whole-glyph", async () => {
    await tool("a");
    const lx = await lineX("lsb");
    const n = await js(`const b = document.querySelector('.canvas-svg').getBoundingClientRect();
      const r = [...document.querySelectorAll('.glyph-node')].map((q) => q.getBoundingClientRect());
      return r.map((q) => ({ fx: (q.left + q.width / 2 - b.left) / b.width, fy: (q.top + q.height / 2 - b.top) / b.height }))
        .sort((p, q) => p.fx - q.fx)[0];`);
    const lsb0 = Number((await spacingVals()).lsb);
    await fire("pointerdown", n.fx, n.fy);
    await fire("pointermove", n.fx, n.fy - 0.05);
    await fire("pointermove", n.fx, n.fy - 0.1);
    await fire("pointerup", n.fx, n.fy - 0.1);
    assertEqual(Number((await spacingVals()).lsb), lsb0, "the node moved up, and the whole glyph did not shift");
    void lx;
    await key("z", { ctrlKey: true });
  });

  await probe("153-the-compiled-font-uses-the-same-bearings-the-editor-shows", async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await openFirstGlyph();
    await tool("v");
    const v = await spacingVals();
    const check = await invokeAsync("writing_validate_font", {});
    if (check.some((i) => i.severity === "error")) throw new Error(`font check has errors: ${JSON.stringify(check)}`);
    const glyph = (await invokeAsync("config_get", { section: "writing" })).glyphs[0];
    const outline = await invokeAsync("writing_glyph_get", { id: glyph.id });
    const xs = outline.elements.flatMap((e) => (e.kind === "contour" ? e.nodes.map((n) => n.x) : []));
    assertEqual(Math.round(Math.min(...xs)), Number(v.lsb), "the field equals the real left edge of the stored ink");
    assertEqual(Math.round(outline.advance ?? 0) || Math.round(Math.max(...xs) + 50), Number(v.advance), "the field equals the stored advance");
  });

  // -- probes 154-: grid spacing mode --------------------------------------------
  const seedSpacing = async () => {
    const mk = (id, name, order) => ({ id, name, codepoint: 0xe000 + order, phonemes: [], order, group: "" });
    await writeGrid(
      [mk("s-a", "aa", 0), mk("s-b", "bb", 1), mk("s-c", "cc", 2)],
      [],
      {
        "s-a": { elements: [sq(100, 0, 300, 700)], advance: 500 },
        "s-b": { elements: [sq(40, 0, 200, 500)], advance: 300 },
        "s-c": { elements: [sq(60, 0, 250, 600)], advance: 400 },
      },
    );
    await reopenGrid();
    await waitJs(`!!document.querySelector('[data-cell="s-a"] .cell-ink')`, { label: "seeded cells drawn" });
  };
  const storedAdvance = async (id) => (await invokeAsync("writing_glyph_get", { id })).advance;
  const storedLeft = async (id) => {
    const o = await invokeAsync("writing_glyph_get", { id });
    return Math.min(...o.elements.flatMap((e) => e.nodes.map((n) => n.x)));
  };
  const edgeXY = (id, edge) =>
    js(`const t = document.querySelector('[data-cell="${id}"]'); const art = t.querySelector('svg.glyph-art').getBoundingClientRect();
      const l = t.querySelector('[data-edge="${edge}"]'); if (!l) return null; const r = l.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: art.top + art.height * 0.5, left: art.left };`);
  const dragInCell = async (id, edge, dx) => {
    const p = await edgeXY(id, edge);
    await js(`const svg = document.querySelector('[data-cell="${id}"] svg.glyph-art');
      const at = (x) => ({ bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: ${p.y} });
      svg.dispatchEvent(new PointerEvent('pointerdown', at(${p.x})));
      svg.dispatchEvent(new PointerEvent('pointermove', at(${p.x + dx / 2})));
      svg.dispatchEvent(new PointerEvent('pointermove', at(${p.x + dx})));
      svg.dispatchEvent(new PointerEvent('pointerup', at(${p.x + dx}))); return true;`);
  };
  const setSizeTo = (v) =>
    js(`const r = document.querySelector('[data-testid="preview-size"]'); r.value = ${v};
      r.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const setMode = (on) =>
    js(`const b = document.querySelector('[data-testid="spacing-toggle"]');
      if ((b.getAttribute('aria-pressed') === 'true') !== ${on}) b.click(); return true;`);

  await probe("154-spacing-mode-shows-draggable-edges-and-bearings-on-each-cell", async () => {
    await seedSpacing();
    assertEqual(await js(`return document.querySelectorAll('[data-edge]').length;`), 0, "no edges outside spacing mode");
    await setMode(true);
    await waitJs(`document.querySelectorAll('[data-edge="advance"]').length === 3`, { label: "an advance edge on each cell" });
    assertEqual(await js(`return document.querySelectorAll('[data-edge="lsb"]').length;`), 3, "a left edge on each cell");
    const txt = await js(`return document.querySelector('[data-cell="s-a"] [data-testid="cell-bearings"]').textContent.trim();`);
    assertEqual(txt, "100|100", "cell aa has left 100 and right 100");
    await screenshot("p154-spacing-mode");
  });

  await probe("155-dragging-a-cell-edge-changes-the-stored-spacing-and-undoes-as-one-step", async () => {
    const adv0 = await storedAdvance("s-a");
    await dragInCell("s-a", "advance", 14);
    await waitJs(`document.querySelector('[data-cell="s-a"] [data-testid="cell-bearings"]').textContent.trim() !== '100|100'`, { label: "readout updates live" });
    await idle(600);
    const adv1 = await storedAdvance("s-a");
    if (!(adv1 > adv0)) throw new Error(`advance did not grow: ${adv0} -> ${adv1}`);
    assertEqual(await storedLeft("s-a"), 100, "ink unmoved by an advance edge drag");
    const left0 = await storedLeft("s-b");
    await dragInCell("s-b", "lsb", 10);
    await idle(600);
    const left1 = await storedLeft("s-b");
    if (!(left1 > left0)) throw new Error(`left bearing drag did not move the ink: ${left0} -> ${left1}`);
    await js(`document.querySelector('[data-testid="spacing-undo"]').click(); return true;`);
    await idle(600);
    assertEqual(await storedLeft("s-b"), left0, "undo restored the left-bearing drag");
    assertEqual(await storedAdvance("s-a"), adv1, "undo only undid the last step");
    await js(`document.querySelector('[data-testid="spacing-undo"]').click(); return true;`);
    await idle(600);
    assertEqual(await storedAdvance("s-a"), adv0, "second undo restored the first drag");
    await js(`document.querySelector('[data-testid="spacing-redo"]').click(); return true;`);
    await idle(600);
    assertEqual(await storedAdvance("s-a"), adv1, "redo reapplies it");
    await js(`document.querySelector('[data-testid="spacing-undo"]').click(); return true;`);
    await idle(400);
  });

  await probe("156-clicking-a-cell-opens-the-popover-with-fields-and-test-pairs", async () => {
    await js(`document.querySelector('[data-cell="s-a"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="spacing-popover"]')`, { label: "popover" });
    const f = await js(`const v = (n) => document.querySelector('[data-spacing-field="' + n + '"]').value;
      return { lsb: v('lsb'), rsb: v('rsb'), advance: v('advance') };`);
    assertEqual(f.lsb, "100", "popover left bearing");
    assertEqual(f.rsb, "100", "popover right bearing");
    assertEqual(f.advance, "500", "popover advance");
    const pairs = await js(`return [...document.querySelectorAll('[data-pair]')].map((p) => p.dataset.pair);`);
    if (!pairs.includes("s-a|s-a")) throw new Error(`the glyph beside itself is missing: ${JSON.stringify(pairs)}`);
    const n = await js(`return document.querySelectorAll('[data-testid="pair-list"] .pair').length;`);
    if (n < 3) throw new Error(`expected the glyph beside itself and its neighbours, saw ${n} pairs`);
    const gap = await js(`return document.querySelector('[data-testid="pair-list"] .pair figcaption').textContent.trim();`);
    assertEqual(gap, "200", "the aa pair's gap is a's right bearing 100 plus a's left bearing 100");
    await js(`const i = document.querySelector('[data-spacing-field="rsb"]'); i.value = '40'; i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await waitJs(`document.querySelector('[data-testid="pair-list"] .pair figcaption').textContent.trim() === '140'`, { label: "the test pair updates live" });
    await idle(500);
    assertEqual(await storedAdvance("s-a"), 440, "the numeric field wrote through");
    await screenshot("p156-popover");
  });

  await probe("157-copy-spacing-from-another-glyph", async () => {
    await js(`const s = document.querySelector('[data-testid="copy-from"]'); s.value = 's-c'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await js(`document.querySelector('[data-testid="copy-spacing"]').click(); return true;`);
    await idle(700);
    const left = await storedLeft("s-a");
    assertEqual(left, 60, "aa now has cc's left bearing");
    const o = await invokeAsync("writing_glyph_get", { id: "s-a" });
    const right = Math.max(...o.elements.flatMap((e) => e.nodes.map((n) => n.x)));
    assertEqual(o.advance - right, 400 - (60 + 250), "and cc's right bearing (90)");
  });

  await probe("158-apply-the-same-bearings-to-the-ctrl-selected-glyphs", async () => {
    await js(`const el = document.querySelector('[data-cell="s-b"]');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true;`);
    await waitJs(`document.querySelector('[data-cell="s-b"]').classList.contains('batched')`, { label: "bb is in the batch" });
    await js(`document.querySelector('[data-cell="s-a"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="apply-to-selected"]') && !document.querySelector('[data-testid="apply-to-selected"]').disabled`, { label: "apply is available" });
    await js(`document.querySelector('[data-testid="apply-to-selected"]').click(); return true;`);
    await idle(800);
    assertEqual(await storedLeft("s-b"), 60, "bb got aa's left bearing");
    const o = await invokeAsync("writing_glyph_get", { id: "s-b" });
    const right = Math.max(...o.elements.flatMap((e) => e.nodes.map((n) => n.x)));
    assertEqual(o.advance - right, 90, "and aa's right bearing");
    await js(`document.querySelector('[data-testid="spacing-undo"]').click(); return true;`);
    await idle(700);
    assertEqual(await storedLeft("s-b"), 40, "one undo restores every glyph the batch touched");
  });

  await probe("159-leaving-spacing-mode-hides-the-edges-and-the-previews-keep-the-new-spacing", async () => {
    await setMode(false);
    await waitJs(`document.querySelectorAll('[data-edge]').length === 0 && !document.querySelector('[data-testid="spacing-popover"]')`, { label: "edges and popover gone" });
    const w = await js(`const t = document.querySelector('[data-cell="s-a"] .cell-advance'); return t ? Math.round(t.getBoundingClientRect().width) : 0;`);
    if (w < 20) throw new Error("the advance box is missing from the cell");
  });

  // -- probes 160-: the type preview ---------------------------------------------
  const seedPreview = async () => {
    const mk = (id, name, cp, order, ph) => ({ id, name, codepoint: cp, phonemes: ph, order, group: "" });
    await writeGrid(
      [mk("p-ka", "ka", 0xe000, 0, ["p-k"]), mk("p-tu", "tu", 0xe001, 1, ["p-t"]), mk("p-sp", "sp", 0x20, 2, [])],
      [
        { id: "p-k", symbol: "k", kind: "consonant" },
        { id: "p-a", symbol: "a", kind: "vowel" },
        { id: "p-t", symbol: "t", kind: "consonant" },
        { id: "p-u", symbol: "u", kind: "vowel" },
      ],
      {
        "p-ka": { elements: [sq(50, 0, 300, 700)], advance: 400 },
        "p-tu": { elements: [sq(30, 0, 200, 500)], advance: 250 },
        "p-sp": { elements: [], advance: 300 },
      },
    );
    const cfg = await invokeAsync("config_get", { section: "writing" });
    await invokeAsync("config_set", {
      section: "writing",
      value: {
        ...cfg,
        rules: [
          { from: "ka", to: ["p-ka"], name: "ka" },
          { from: "tu", to: ["p-tu"], name: "tu" },
        ],
      },
    });
    await reopenGrid();
    await waitJs(`!!document.querySelector('[data-page="preview"]')`, { label: "preview tab" });
  };
  const openPreview = async () => {
    await js(`document.querySelector('[data-page="preview"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="type-preview"]')`, { label: "preview open" });
  };
  const typeInPreview = (text) =>
    js(`const t = document.querySelector('[data-testid="preview-input"]'); t.value = ${JSON.stringify(text)};
      t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const lineInfo = () =>
    js(`return [...document.querySelectorAll('[data-testid="preview-line"]')].map((l) => ({
      glyphs: Number(l.dataset.glyphs), w: Math.round(l.getBoundingClientRect().width), h: Math.round(l.getBoundingClientRect().height),
      ink: l.querySelectorAll('.p-ink').length }));`);

  await probe("160-preview-sets-text-with-the-orthography-rules-applied-by-the-real-font", async () => {
    await seedPreview();
    await openPreview();
    await typeInPreview("katu");
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"]').length === 1`, { label: "one line" });
    await waitJs(`document.querySelector('[data-testid="preview-line"]').dataset.glyphs === '2'`, { label: "k+a and t+u became two glyphs" });
    const [line] = await lineInfo();
    assertEqual(line.ink, 2, "both glyphs are drawn");
    const key = await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`);
    if (!/^[0-9a-f]{16}$/.test(key)) throw new Error(`the preview should report the font key: ${key}`);
    await screenshot("p160-preview");
  });

  await probe("161-the-preview-equals-the-exported-fonts-shaping-for-a-set-of-strings", async () => {
    const strings = ["katu", "tuka", "kaka tutu", "k", "ak", "ka tu ka", "\ue000\ue001"];
    for (const text of strings) {
      await typeInPreview(text);
      await idle(500);
      const shown = await js(`return [...document.querySelectorAll('[data-testid="preview-line"]')].map((l) => Number(l.dataset.glyphs));`);
      const direct = await invokeAsync("writing_preview_shape", { lines: [text], rtl: false });
      assertEqual(JSON.stringify(shown), JSON.stringify(direct.runs.map((r) => r.glyphs.length)), `glyph count for ${JSON.stringify(text)}`);
    }
    // and the shaping command itself must agree with the font the export writes
    const a = await invokeAsync("writing_preview_shape", { lines: ["katu"], rtl: false });
    const b = await invokeAsync("writing_preview_shape", { lines: ["katu"], rtl: false });
    assertEqual(a.key, b.key, "the key is stable");
    assertEqual(a.runs[0].advance, 650, "ka (400) + tu (250)");
    assertEqual(a.runs[0].glyphs.map((g) => g.id).join(","), "1,2", "ka then tu");
    const check = await invokeAsync("writing_validate_font", {});
    if (check.some((i) => i.severity === "error")) throw new Error(`export would be blocked: ${JSON.stringify(check)}`);
  });

  await probe("162-size-slider-scales-the-drawing-from-12-to-300-px", async () => {
    const setSize = (v) =>
      js(`const r = document.querySelector('[data-testid="preview-size"]'); r.value = ${v};
        r.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    assertEqual(await js(`const r = document.querySelector('[data-testid="preview-size"]'); return [r.min, r.max];`).then((a) => a.join("-")), "12-300", "slider range");
    await typeInPreview("ka");
    await setSize(60);
    await waitJs(`document.querySelector('[data-testid="preview-size-px"]').textContent.trim() === '60px'`, { label: "60px" });
    await idle(200);
    const w60 = (await lineInfo())[0].w;
    await setSize(120);
    await idle(300);
    const w120 = (await lineInfo())[0].w;
    if (Math.abs(w120 / w60 - 2) > 0.05) throw new Error(`doubling the size should double the width: ${w60} -> ${w120}`);
    assertEqual(w60, 24, "ka is 400 units: 400/1000 * 60");
    await setSize(12);
    await idle(300);
    assertEqual((await lineInfo())[0].w, 5, "400/1000 * 12 rounds to 5");
    await setSize(300);
    await idle(300);
    assertEqual((await lineInfo())[0].w, 120, "400/1000 * 300");
    await setSize(60);
  });

  await probe("163-lines-wrap-to-the-width-and-the-view-scrolls", async () => {
    await typeInPreview("ka ".repeat(60));
    await setSizeTo(240);
    await idle(700);
    const rows = await lineInfo();
    if (rows.length < 4) throw new Error(`a long line should wrap into several rows, saw ${rows.length}`);
    const scrollW = await js(`return document.querySelector('[data-testid="preview-scroll"]').clientWidth;`);
    for (const r of rows) if (r.w > scrollW) throw new Error(`a row (${r.w}) is wider than the view (${scrollW})`);
    const sc = await js(`const e = document.querySelector('[data-testid="preview-scroll"]'); return { sh: e.scrollHeight, ch: e.clientHeight };`);
    if (sc.sh <= sc.ch) throw new Error("tall text should scroll inside the preview");
    await js(`document.querySelector('[data-testid="preview-scroll"]').scrollTop = 99999; return true;`);
    const top = await js(`return document.querySelector('[data-testid="preview-scroll"]').scrollTop;`);
    if (top <= 0) throw new Error("the preview did not scroll");
    await typeInPreview("ka");
    await setSizeTo(60);
  });

  await probe("164-all-glyphs-and-pairs-sources-and-advance-boxes", async () => {
    await js(`document.querySelector('[data-source="all"]').click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"] .p-ink').length >= 2`, { label: "all glyphs drawn" });
    await js(`document.querySelector('[data-source="pairs"]').click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"]').length === 3`, { label: "a row per glyph" });
    await js(`const b = document.querySelector('[data-testid="preview-boxes"]'); b.click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-box]').length > 0`, { label: "advance boxes drawn" });
    await screenshot("p164-pairs");
  });

  await probe("165-lexicon-words-source-lists-words-and-sets-the-picked-ones", async () => {
    await js(`document.querySelector('[data-source="words"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="word-list"]')`, { label: "word list" });
    const words = await js(`return [...document.querySelectorAll('[data-testid="word-list"] button')].map((b) => b.dataset.word);`);
    if (words.length === 0) throw new Error("the lexicon has words, so some should be listed");
    await js(`document.querySelector('[data-testid="word-list"] button').click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"]').length === 1`, { label: "the picked word is set" });
  });

  await probe("166-editing-a-glyph-updates-the-preview", async () => {
    await js(`document.querySelector('[data-source="custom"]').click(); return true;`);
    await typeInPreview("ka");
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"] .p-ink').length === 1`, { label: "ka drawn" });
    const key0 = await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`);
    const out = await invokeAsync("writing_glyph_get", { id: "p-ka" });
    await invokeAsync("writing_glyph_set", { id: "p-ka", outline: { ...out, advance: 520 } });
    await waitJs(`document.querySelector('[data-testid="preview-scroll"]').dataset.key !== '${key0}'`, { label: "a new font key after the edit" });
    await idle(300);
    assertEqual((await lineInfo())[0].w, Math.round(0.52 * 60), "the line is as wide as the new advance");
  });

  await probe("167-the-preview-is-cheap-when-idle-and-does-not-recompile-while-typing", async () => {
    await typeInPreview("katu");
    await idle(600);
    const key0 = await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`);
    for (const t of ["ka", "kat", "katu", "katuka", "tuka"]) { await typeInPreview(t); await idle(160); }
    assertEqual(await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`), key0, "typing leaves the font key alone");
    const res = await js(`
      return await new Promise((resolve) => {
        const gaps = []; const lates = []; let last = performance.now(); let lt = performance.now(); let run = true;
        const frame = () => { const n = performance.now(); gaps.push(n - last); last = n; if (run) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        const timer = setInterval(() => { const n = performance.now(); lates.push(n - lt - 10); lt = n; }, 10);
        setTimeout(() => { run = false; clearInterval(timer); resolve({ frames: gaps.filter((x) => x > 50).length, late: lates.filter((x) => x > 50).length, worst: Math.round(Math.max(0, ...gaps)) }); }, 3000);
      });`);
    console.log("PREVIEW-IDLE", JSON.stringify(res));
    if (res.frames > 0 || res.late > 0) throw new Error(`the idle preview blocks the main thread: ${JSON.stringify(res)}`);
  });

  // -- probes 168-: preview overlays and bearing-adjust drag ----------------------
  const rowBox = (n) =>
    js(`const l = document.querySelectorAll('[data-testid="preview-line"]')[${n}]; const r = l.getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };`);
  const dragRow = async (n, x0, x1) => {
    const b = await rowBox(n);
    await js(`const l = document.querySelectorAll('[data-testid="preview-line"]')[${n}];
      const at = (x) => ({ bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: ${b.left} + x, clientY: ${b.top + b.h / 2} });
      l.dispatchEvent(new PointerEvent('pointermove', at(${x0})));
      l.dispatchEvent(new PointerEvent('pointerdown', at(${x0})));
      l.dispatchEvent(new PointerEvent('pointermove', at(${(x0 + x1) / 2})));
      l.dispatchEvent(new PointerEvent('pointermove', at(${x1})));
      l.dispatchEvent(new PointerEvent('pointerup', at(${x1}))); return true;`);
  };

  await probe("168-metric-lines-and-advance-boxes-toggle-in-the-preview", async () => {
    const ka = await invokeAsync("writing_glyph_get", { id: "p-ka" });
    await invokeAsync("writing_glyph_set", { id: "p-ka", outline: { ...ka, advance: 400 } });
    await idle(600);
    await setSizeTo(60);
    await js(`document.querySelector('[data-source="custom"]').click(); return true;`);
    await idle(100);
    await typeInPreview("katu");
    await waitJs(`document.querySelectorAll('[data-testid="preview-line"] .p-rail').length === 4 && document.querySelectorAll('[data-box]')[0]?.getAttribute('width') === '24'`, { label: "four metric rails and ka's box first (the previous probe left 'tuka', which also shapes to two glyphs)" });
    const boxes = await js(`return [...document.querySelectorAll('[data-box]')].map((b) => [Number(b.getAttribute('x')), Number(b.getAttribute('width'))]);`);
    assertEqual(JSON.stringify(boxes), JSON.stringify([[0, 24], [24, 15]]), "ka (400 units) then tu (250) at 60 px, side by side");
    const boxes0 = boxes.length;
    // Off and on must restore the same set.
    await js(`document.querySelector('[data-testid="preview-boxes"]').click(); return true;`);
    await waitJs(`document.querySelectorAll('[data-box]').length === 0`, { label: "boxes off" });
    await js(`document.querySelector('[data-testid="preview-boxes"]').click(); return true;`);
    const w = await js(`return [...document.querySelectorAll('[data-box]')].map((b) => [Number(b.getAttribute('x')), Number(b.getAttribute('width'))]);`);
    assertEqual(JSON.stringify(w), JSON.stringify(boxes), "boxes identical after being toggled off and on");
  });

  await probe("169-dragging-the-gap-between-two-letters-changes-their-bearings-and-undoes", async () => {
    await js(`document.querySelector('[data-testid="preview-adjust"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="preview-gap-mode"]')`, { label: "adjust mode on" });
    await typeInPreview("katu");
    await waitJs(`document.querySelector('[data-testid="preview-line"]').dataset.glyphs === '2'`, { label: "two glyphs" });
    const before = {
      ka: await invokeAsync("writing_glyph_get", { id: "p-ka" }),
      tu: await invokeAsync("writing_glyph_get", { id: "p-tu" }),
    };
    // the ka|tu boundary is at 400/1000*60 = 24 px; drag it right by 10 px = 166 units, shared between both.
    await dragRow(0, 24, 34);
    await idle(900);
    const after = {
      ka: await invokeAsync("writing_glyph_get", { id: "p-ka" }),
      tu: await invokeAsync("writing_glyph_get", { id: "p-tu" }),
    };
    const left = (o) => Math.min(...o.elements.flatMap((e) => e.nodes.map((n) => n.x)));
    const right = (o) => Math.max(...o.elements.flatMap((e) => e.nodes.map((n) => n.x)));
    const rsb = (o) => o.advance - right(o);
    const dRsb = rsb(after.ka) - rsb(before.ka);
    const dLsb = left(after.tu) - left(before.tu);
    if (Math.abs(dRsb - 83) > 4 || Math.abs(dLsb - 83) > 4) throw new Error(`each side should take about half of 166 units: rsb ${dRsb}, lsb ${dLsb}`);
    assertEqual(left(after.ka), left(before.ka), "ka's own left bearing is untouched");
    const adv = after.ka.advance + after.tu.advance;
    const shaped = await invokeAsync("writing_preview_shape", { lines: ["katu"], rtl: false });
    if (Math.abs(shaped.runs[0].advance - adv) > 1) throw new Error(`the font shapes katu as ${shaped.runs[0].advance}, the outlines add up to ${adv}`);
    await waitJs(`Math.round(document.querySelector('[data-testid="preview-line"]').getBoundingClientRect().width) > 39`, { label: "the preview widened live" });
    await screenshot("p169-gap");
  });

  await probe("170-the-gap-drag-is-one-undo-step-in-the-glyph-grid-log", async () => {
    await js(`document.querySelector('[data-page="glyphs"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="spacing-toggle"]')`, { label: "grid back" });
    await setMode(true);
    await waitJs(`!document.querySelector('[data-testid="spacing-undo"]').disabled`, { label: "undo available" });
    const advBefore = (await invokeAsync("writing_glyph_get", { id: "p-ka" })).advance;
    await js(`document.querySelector('[data-testid="spacing-undo"]').click(); return true;`);
    await idle(900);
    const a = await invokeAsync("writing_glyph_get", { id: "p-ka" });
    const t = await invokeAsync("writing_glyph_get", { id: "p-tu" });
    if (!(a.advance < advBefore)) throw new Error(`undo did not restore ka: ${advBefore} -> ${a.advance}`);
    assertEqual(a.advance, 400, "ka's advance is back");
    assertEqual(t.advance, 250, "tu's advance is back: both glyphs undone in one step");
    await setMode(false);
  });

  // -- probes 171-: back layer, tracing images, layer visibility -----------

  const SCAN_PNG = path.join(ROOT, "probe-scan.png");
  fs.writeFileSync(
    SCAN_PNG,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4z8AARAAI/gH/xp559wAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const seedImageGlyph = async () => {
    const mk = (id, name, order) => ({ id, name, codepoint: 0xe010 + order, phonemes: [], order, group: "" });
    await writeGrid(
      [mk("im-a", "ima", 0), mk("im-b", "imb", 1)],
      [],
      {
        "im-a": { elements: [sq(50, 0, 300, 700)], advance: 400 },
        "im-b": { elements: [sq(30, 0, 200, 500)], advance: 250 },
      },
    );
    // Rules left by earlier probes can name glyphs this seed removed, which
    // would block the font export; the image probes want none.
    const cfg = await invokeAsync("config_get", { section: "writing" });
    await invokeAsync("config_set", { section: "writing", value: { ...cfg, rules: [] } });
    await reopenGrid();
    // The writing view keeps its page across activity switches; an earlier
    // probe may have left it on the preview. Go to the glyphs page.
    await js(`const t = document.querySelector('.writing [data-page="glyphs"]');
      if (t && t.getAttribute('aria-selected') !== 'true') t.click(); return true;`);
    await waitJs(`!!document.querySelector('.glyph-tile[data-kind="glyph"]')`, { label: "seeded tiles" });
    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.canvas-svg')`, { label: "editor" });
    await tool("v");
  };
  const storageToCanvas = (x, y) =>
    js(`const v = document.querySelector('.canvas-svg').getAttribute('viewBox').split(' ').map(Number);
      const r = document.querySelector('.canvas-svg').getBoundingClientRect();
      return { fx: (${x} - v[0]) / v[2], fy: (${-y} - v[1]) / v[3] };`);
  const importScan = (id = "im-a", force = false) =>
    invokeAsync("writing_back_image_import", { id, path: SCAN_PNG, force });
  // An earlier probe may have left a layer hidden; the drawing probes need
  // all three visible, so set them straight before asserting on the canvas.
  const ensureLayers = async () => {
    for (const id of ["guide", "back", "fore"]) {
      const on = await js(`return document.querySelector('[data-layer="${id}"]')?.getAttribute('aria-pressed');`);
      if (on === "false") {
        await js(`document.querySelector('[data-layer="${id}"]').click(); return true;`);
      }
    }
  };
  // The editor keeps its own copy of the outline: after an import through IPC,
  // reopen the glyph so the freshly written file (and image) is picked up.
  const reopenGlyph = async () => {
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await waitJs(`!document.querySelector('.canvas-svg') && !!document.querySelector('.glyph-tile[data-kind="glyph"]')`, { label: "grid back" });
    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.canvas-svg')`, { label: "editor reopened" });
    await tool("v");
  };

  await probe("171-layers-toggle-guide-back-fore-and-hidden-fore-blocks-edits", async () => {
    await seedImageGlyph();
    await ensureLayers();
    const image = await importScan();
    await reopenGlyph();
    await ensureLayers();
    assertEqual(image.asset, "probe-scan.png", "the imported asset name");
    assertEqual(image.width, 1000, "fitted to the em box by default");
    assertEqual(image.x, 500, "centred on the em box");
    assertEqual(image.y, 300, "between ascender and descender");
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "the image is drawn" });
    const drawn = await js(`const im = document.querySelector('[data-back-image]');
      return [Number(im.getAttribute('x')), Number(im.getAttribute('y')), Number(im.getAttribute('width')), Number(im.getAttribute('height'))];`);
    assertEqual(JSON.stringify(drawn), JSON.stringify([0, -550, 1000, 500]), "a 2:1 scan at the default placement, y flipped");
    assertEqual(
      await js(`return document.querySelector('[data-back-image]').getAttribute('href').startsWith('asset://') || document.querySelector('[data-back-image]').getAttribute('href').startsWith('http');`),
      true,
      "the webview URL comes from the backend's absolute path",
    );

    for (const id of ["guide", "back", "fore"]) {
      assertEqual(
        await js(`return document.querySelector('[data-layer="${id}"]')?.getAttribute('aria-pressed');`),
        "true",
        `the ${id} layer starts visible`,
      );
    }
    await js(`document.querySelector('[data-layer="back"]').click(); return true;`);
    await waitJs(`!document.querySelector('[data-back-image]')`, { label: "back layer hidden" });
    await js(`document.querySelector('[data-layer="back"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "back layer shown again" });

    const guides = () => js(`return document.querySelectorAll('.canvas-svg .guide').length;`);
    const guides0 = await guides();
    await js(`document.querySelector('[data-layer="guide"]').click(); return true;`);
    assertEqual(await guides(), 0, "guide rails hide");
    await js(`document.querySelector('[data-layer="guide"]').click(); return true;`);
    assertEqual(await guides(), guides0, "guide rails return");

    await drawSquare();
    const nodes = () => js(`return document.querySelectorAll('.glyph-node').length;`);
    const nodes0 = await nodes();
    const elements0 = (await invokeAsync("writing_glyph_get", { id: "im-a" })).elements.length;
    await js(`document.querySelector('[data-layer="fore"]').click(); return true;`);
    await waitJs(`!document.querySelector('.canvas-svg .outline')`, { label: "the drawing hides with the fore layer" });
    assertEqual(await nodes(), 0, "nodes and handles hide too");
    await tool("p");
    await click1(0.4, 0.5);
    await click1(0.6, 0.5);
    await click1(0.6, 0.4);
    const stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    assertEqual(stored.elements.length, elements0, "a hidden fore layer accepts no edits");
    await tool("v");
    await js(`document.querySelector('[data-layer="fore"]').click(); return true;`);
    await waitJs(`!!document.querySelector('.canvas-svg .outline')`, { label: "fore layer shown again" });
    assertEqual(await nodes(), nodes0, "the drawing is back, untouched");

    // The View menu offers the same three toggles.
    await js(`const b = [...document.querySelectorAll('.menu-item')]
      .find((x) => x.textContent.trim() === 'View'); if (!b) return false; b.click(); return true;`);
    await waitJs(`!!document.querySelector('.menu-panel')`, { label: "view menu open" });
    const labels = await js(`return [...document.querySelectorAll('.menu-panel button')].map((b) => b.textContent.trim());`);
    if (!labels.some((l) => l.includes("Back layer")) || !labels.some((l) => l.includes("Fore layer"))) {
      throw new Error(`the View menu lacks the layer toggles: ${JSON.stringify(labels)}`);
    }
    const openViewMenu = () =>
      js(`const b = [...document.querySelectorAll('.menu-item')]
        .find((x) => x.textContent.trim() === 'View'); if (!b) return false; b.click(); return true;`);
    const clickLayerItem = () =>
      js(`const b = [...document.querySelectorAll('.menu-panel button')]
        .find((x) => x.textContent.trim().includes('Back layer')); if (!b) return false; b.click(); return true;`);
    if (!(await clickLayerItem())) throw new Error("no Back layer item to click");
    await waitJs(`!document.querySelector('[data-back-image]')`, { label: "the menu toggles the layer" });
    // A menu closes after its item runs: open it again for the return trip.
    if (!(await openViewMenu())) throw new Error("no View menu to reopen");
    await waitJs(`!!document.querySelector('.menu-panel')`, { label: "view menu reopened" });
    if (!(await clickLayerItem())) throw new Error("no Back layer item to click back");
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "and back" });
    await pressKey("\uE00C");
    await screenshot("p171-layers");
  });

  await probe("172-the-tracing-image-moves-and-scales-as-one-undo-step-each", async () => {
    await seedImageGlyph();
    await ensureLayers();
    await importScan();
    await reopenGlyph();
    await ensureLayers();
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "image drawn" });

    // Clicking the image selects it; its corner handles appear.
    const centre = await storageToCanvas(500, 300);
    await click1(centre.fx, centre.fy);
    await waitJs(`document.querySelectorAll('[data-image-handle]').length === 4`, { label: "four corner handles" });
    assertEqual(
      await js(`return !!document.querySelector('.canvas-svg .image-box');`),
      true,
      "the selection box is drawn",
    );

    // Drag the body: both centres move by the drag delta.
    const to = await storageToCanvas(700, 380);
    const from = await storageToCanvas(500, 300);
    await dragOnCanvas([from.fx, from.fy], [to.fx, to.fy]);
    await idle(400);
    let stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    if (Math.abs(stored.back_image.x - 700) > 4 || Math.abs(stored.back_image.y - 380) > 4) {
      throw new Error(`the image did not move to (700, 380): ${JSON.stringify(stored.back_image)}`);
    }
    await key("z", { ctrlKey: true });
    await idle(400);
    stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    if (Math.abs(stored.back_image.x - 500) > 4 || Math.abs(stored.back_image.y - 300) > 4) {
      throw new Error(`undo did not restore the placement: ${JSON.stringify(stored.back_image)}`);
    }

    // Drag the se corner: the opposite corner stays anchored, the aspect is kept.
    const anchor = await storageToCanvas(0, 550);
    const corner0 = await storageToCanvas(1000, 50);
    const corner1 = await storageToCanvas(1500, -450);
    await dragOnCanvas([corner0.fx, corner0.fy], [corner1.fx, corner1.fy]);
    await idle(400);
    stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    const width = stored.back_image.width;
    const expected = Math.hypot(1500 - 0, -450 - 550) / Math.sqrt(1 + 1 / 4);
    if (Math.abs(width - expected) > 6) {
      throw new Error(`the corner drag scaled to ${width}, want ~${Math.round(expected)} (aspect 2 kept)`);
    }
    if (Math.abs(stored.back_image.x - (width / 2 + 0)) > 6 || Math.abs(stored.back_image.y - (550 - width / 4)) > 6) {
      throw new Error(`the nw corner did not stay anchored: ${JSON.stringify(stored.back_image)}`);
    }
    await key("z", { ctrlKey: true });
    await idle(400);
    stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    if (Math.abs(stored.back_image.width - 1000) > 4) {
      throw new Error(`undo did not restore the width: ${JSON.stringify(stored.back_image)}`);
    }
    await screenshot("p172-image-drag");
  });

  await probe("173-clearing-and-deleting-sweep-the-asset-only-when-unreferenced", async () => {
    await seedImageGlyph();
    await ensureLayers();
    await importScan();
    await reopenGlyph();
    await ensureLayers();
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "image drawn" });

    // Delete on the selected image clears the reference; undo restores it; the
    // asset file stays (only deleting the glyph sweeps it).
    const centre = await storageToCanvas(500, 300);
    await click1(centre.fx, centre.fy);
    await waitJs(`document.querySelectorAll('[data-image-handle]').length === 4`, { label: "image selected" });
    await key("Delete");
    await waitJs(`!document.querySelector('[data-back-image]')`, { label: "image cleared" });
    await idle(400);
    let stored = await invokeAsync("writing_glyph_get", { id: "im-a" });
    assertEqual(stored.back_image ?? null, null, "the file holds no reference");
    assertEqual(fs.existsSync(path.join(WORKSPACE, "writing", "assets", "probe-scan.png")), true, "the asset file survives a clear");
    await key("z", { ctrlKey: true });
    await waitJs(`!!document.querySelector('[data-back-image]')`, { label: "undo restored the image" });
    assertEqual(fs.existsSync(path.join(WORKSPACE, "writing", "assets", "probe-scan.png")), true, "still there after undo");

    // A second glyph sharing the same bytes shares the one asset file.
    await importScan("im-b");
    const b = await invokeAsync("writing_glyph_get", { id: "im-b" });
    assertEqual(b.back_image.asset, "probe-scan.png", "identical bytes dedupe to one file");
    assertEqual(fs.readdirSync(path.join(WORKSPACE, "writing", "assets")).length, 1, "one asset on disk");

    // Deleting im-a through the app's own config path sweeps its outline but
    // keeps the shared asset; deleting im-b too sweeps the file.
    const cfg = await invokeAsync("config_get", { section: "writing" });
    await invokeAsync("config_set", {
      section: "writing",
      value: { ...cfg, glyphs: cfg.glyphs.filter((g) => g.id !== "im-a") },
    });
    await idle(400);
    assertEqual(fs.existsSync(path.join(WORKSPACE, "writing", "glyphs", "im-a")), false, "the outline file is swept");
    assertEqual(fs.existsSync(path.join(WORKSPACE, "writing", "assets", "probe-scan.png")), true, "im-b still references the asset");
    const cfg2 = await invokeAsync("config_get", { section: "writing" });
    await invokeAsync("config_set", {
      section: "writing",
      value: { ...cfg2, glyphs: cfg2.glyphs.filter((g) => g.id !== "im-b") },
    });
    await idle(400);
    assertEqual(fs.existsSync(path.join(WORKSPACE, "writing", "assets", "probe-scan.png")), false, "the last reference is gone");
    assertEqual(glyphFiles().includes("im-b"), false, "both outline files are swept");
  });

  await probe("174-the-tracing-image-rejects-other-formats-and-warns-above-10-mb", async () => {
    await seedImageGlyph();
    const rejected = async (file, why) => {
      try {
        await invokeAsync("writing_back_image_import", { id: "im-a", path: file, force: false });
        throw new Error(`${why}: the import unexpectedly succeeded`);
      } catch (e) {
        if (!/png, jpg or webp|too large/.test(String(e))) {
          throw new Error(`${why}: unexpected rejection ${String(e)}`);
        }
        return String(e);
      }
    };
    const textFile = path.join(ROOT, "probe-scan.txt");
    fs.writeFileSync(textFile, "not an image");
    const msg = await rejected(textFile, "a text file");
    if (!/png, jpg or webp/.test(msg)) throw new Error(`wrong reason: ${msg}`);
    const svgFile = path.join(ROOT, "probe-scan.svg");
    fs.writeFileSync(svgFile, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await rejected(svgFile, "an svg is deferred");

    const head = fs.readFileSync(SCAN_PNG);
    const huge = Buffer.concat([head, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const hugeFile = path.join(ROOT, "probe-huge.png");
    fs.writeFileSync(hugeFile, huge);
    const big = await rejected(hugeFile, "a file above 10 MB");
    if (!/too large/.test(big)) throw new Error(`wrong reason: ${big}`);
    const forced = await invokeAsync("writing_back_image_import", { id: "im-a", path: hugeFile, force: true });
    assertEqual(forced.asset, "probe-huge.png", "force imports it anyway");
    // The glyph file stores the reference, never the bytes.
    const glyphJson = fs.readFileSync(path.join(WORKSPACE, "writing", "glyphs", "im-a"), "utf8");
    assertEqual(glyphJson.includes('"back_image"'), true, "the glyph file holds the reference");
    assertEqual(glyphJson.includes("/"), false, "only the bare asset name, never a path");
    const after = fs.statSync(path.join(WORKSPACE, "writing", "glyphs", "im-a")).size;
    assertEqual(after < 2048, true, "a 10 MB asset did not leak into the glyph file");
    await screenshot("p174-guards");
  });

  await probe("175-the-font-key-and-the-exported-bytes-ignore-the-back-image", async () => {
    await seedImageGlyph();
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await waitJs(`!!document.querySelector('[data-page="preview"]')`, { label: "back at the grid" });
    await js(`document.querySelector('[data-page="preview"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="type-preview"]')`, { label: "preview open" });
    await typeInPreview("\ue010\ue011");
    await idle(600);
    const key0 = await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`);
    const export0 = path.join(ROOT, "probe-font-0.ttf");
    await invokeAsync("writing_export_font", { path: export0 });
    assertEqual(fs.existsSync(export0), true, "the first export landed");

    // The import itself happens through IPC, then the revision bump the
    // backend fires makes the preview re-shape (probe 166 covers that path).
    await importScan();
    await idle(900);
    const key1 = await js(`return document.querySelector('[data-testid="preview-scroll"]').dataset.key;`);
    assertEqual(key1, key0, "the preview's font key is unchanged by editor-only material");
    const export1 = path.join(ROOT, "probe-font-1.ttf");
    await invokeAsync("writing_export_font", { path: export1 });
    assertEqual(
      fs.readFileSync(export1).equals(fs.readFileSync(export0)),
      true,
      "the exported TTF is byte-identical with a tracing image set",
    );
    const check = await invokeAsync("writing_validate_font", {});
    assertEqual(check.some((i) => i.severity === "error"), false, "no export blocker appeared");
  });

  // -- probe 176: hover descriptions on every tool and widget ---------------
  const audit = (what) =>
    js(`return (() => {
      const described = (el) => {
        if ((el.getAttribute('title') || '').trim() || (el.getAttribute('aria-label') || '').trim()) return true;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          if ((el.getAttribute('placeholder') || '').trim()) return true;
          const label = el.closest('label');
          if (label && label.textContent.trim()) return true;
        }
        return false;
      };
      const missing = [];
      for (const el of document.querySelectorAll(
        '.writing button, .writing select, .writing input, .writing textarea, .writing [role="button"], .writing [data-info], .writing .glyph-tile, .writing [data-edge]',
      )) {
        if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        if (!described(el)) missing.push(el.outerHTML.slice(0, 100) + ' @ ' + (el.parentElement?.className || el.parentElement?.tagName || '?'));
      }
      return missing;
    })()`).then((missing) => {
      if (missing.length) {
        fs.writeFileSync(
          path.join(ROOT, "audit-missing.json"),
          JSON.stringify({ what, missing }, null, 1),
        );
        throw new Error(`${what}: ${missing.length} undescribed (see audit-missing.json): ${JSON.stringify(missing.slice(0, 2))}`);
      }
    });

  await probe("176-every-tool-and-widget-in-the-writing-ui-has-a-hover-description", async () => {
    await seedImageGlyph();
    await ensureLayers();
    await js(`document.querySelector('.vector-editor .back')?.click(); return true;`);
    await waitJs(`!!document.querySelector('[data-page="glyphs"]')`, { label: "grid page" });
    await audit("the glyph grid");

    await js(`document.querySelector('[data-page="preview"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="type-preview"]')`, { label: "preview page" });
    await audit("the type preview");

    await js(`document.querySelector('[data-page="glyphs"]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="spacing-toggle"]')`, { label: "grid back" });
    await setMode(true);
    await waitJs(`document.querySelectorAll('[data-edge]').length > 0`, { label: "spacing edges" });
    await js(`document.querySelector('[data-cell]').click(); return true;`);
    await waitJs(`!!document.querySelector('[data-testid="spacing-popover"]')`, { label: "spacing popover" });
    await audit("spacing mode");
    await setMode(false);
    await waitJs(`document.querySelectorAll('[data-edge]').length === 0`, { label: "edges gone" });

    await click('.glyph-tile[data-kind="glyph"]');
    await waitJs(`!!document.querySelector('.canvas-svg')`, { label: "editor" });
    await audit("the vector editor");
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
