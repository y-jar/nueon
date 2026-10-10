//! Regenerate docs/MAP.md from the one-line module headers.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

function headerOf(rel) {
  const first = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n")[0];
  const m = first.match(/^\/\/!\s?(.*)$|^<!--\s?(.*?)\s?-->$/);
  return m ? (m[1] ?? m[2]).trim() : null;
}

const files = [];
(function walk(dir, base) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (entry.isDirectory()) walk(abs, base);
    else if (/\.(ts|svelte)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      const h = headerOf(rel);
      if (h) files.push({ rel, h });
    }
  }
})(SRC, "src");

const byDir = new Map();
for (const f of files) {
  const dir = path.dirname(f.rel);
  if (!byDir.has(dir)) byDir.set(dir, []);
  byDir.get(dir).push(f);
}

const out = [
  "# Source map",
  "",
  "Auto-generated from the one-line module headers (`//!` / `<!-- -->`) by",
  "`scripts/gen-map.mjs`. Do not edit by hand; edit the header in the source file",
  "and regenerate.",
  "",
];

for (const [dir, entries] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`## \`${dir}\``, "");
  for (const { rel, h } of entries) {
    const name = path.basename(rel);
    out.push(`- \`${name}\` — ${h}`);
  }
  out.push("");
}

fs.writeFileSync(path.join(ROOT, "docs", "MAP.md"), out.join("\n") + "\n");
console.log(`docs/MAP.md written (${files.length} files)`);
