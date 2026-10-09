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

    // Ctrl+Shift+L toggles a task item, matching the TaskWidget rendering.
    await pressKey("l", [CTRL, SHIFT]);
    assertEqual(await editorText("fmt.md"), "- [ ] plain line\n", "Ctrl+Shift+L on");
    await pressKey("l", [CTRL, SHIFT]);
    assertEqual(await editorText("fmt.md"), "plain line\n", "Ctrl+Shift+L off");

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
    if (!has("Ctrl+Shift+L", "Task list")) throw new Error("no task binding");
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
