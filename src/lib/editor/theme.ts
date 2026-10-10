import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Earthy theme matching the app palette. */
export const theme = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--bg)",
      height: "100%",
    },
    ".cm-scroller": { overflow: "auto", fontFamily: "inherit" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
      fontSize: "13px",
      lineHeight: "1.65",
      padding: "8px 0",
      caretColor: "var(--accent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(196,148,92,0.30) !important",
    },
    ".cm-gutters": {
      backgroundColor: "var(--panel)",
      color: "var(--muted)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.035)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.035)" },
    ".cm-h1": { fontSize: "1.7em", fontWeight: "700", lineHeight: "1.4" },
    ".cm-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.4" },
    ".cm-h3": { fontSize: "1.25em", fontWeight: "600" },
    ".cm-h4": { fontSize: "1.12em", fontWeight: "600" },
    ".cm-h5": { fontSize: "1.02em", fontWeight: "600" },
    ".cm-h6": { fontSize: "1em", fontWeight: "600" },
    ".cm-strong": { fontWeight: "700", color: "#f0e8d8" },
    ".cm-em": { fontStyle: "italic" },
    ".cm-code": {
      fontFamily: "ui-monospace, monospace",
      background: "var(--faint)",
      borderRadius: "3px",
      padding: "0 3px",
    },
    ".cm-link": {
      color: "var(--accent)",
      textDecoration: "underline",
      cursor: "pointer",
    },
    ".cm-bullet": { color: "var(--accent)", fontWeight: "700" },
    ".cm-dict": {
      color: "var(--accent)",
      borderBottom: "1px dotted rgba(196,148,92,0.55)",
      cursor: "help",
    },
    ".cm-wikilink": {
      color: "var(--accent)",
      borderBottom: "1px solid var(--accent)",
      cursor: "pointer",
    },
    ".cm-wikilink-word": { fontWeight: "600" },
    ".cm-wikilink-note": { color: "var(--fg)" },
    ".cm-wikilink-embed": { fontStyle: "italic" },
    ".cm-wikilink-embed-widget": {
      display: "inline-block",
      padding: "0 4px",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--text)",
    },
    ".cm-wikilink-unresolved": {
      color: "#d6785a",
      borderBottom: "1px dashed #d6785a",
    },
    ".cm-wikilink-heading-broken": {
      color: "#d6785a",
      borderBottom: "1px dashed #d6785a",
    },
    ".cm-wikilink-heading": {
      color: "var(--muted)",
      borderBottom: "none",
    },
    // Completion dropdown: the base theme paints the selected row indigo with
    // white text, and our own editor.css re-colours the label to the dark
    // panel colour — dark text on indigo. Override it with a soft accent-tinted
    // background, readable text, and a 2px left accent bar.
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "color-mix(in srgb, var(--accent) 22%, var(--panel))",
      color: "var(--text)",
      boxShadow: "inset 2px 0 0 var(--accent)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionLabel":
      { color: "var(--text)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail":
      { color: "var(--muted)" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li:hover:not([aria-selected])": {
      background: "rgba(255, 255, 255, 0.05)",
    },
  },
  { dark: true },
);

/** Fallback syntax highlighting for constructs not concealed. */
export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, fontWeight: "700" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: tags.link, color: "var(--accent)" },
    { tag: tags.monospace, fontFamily: "ui-monospace, monospace" },
    { tag: tags.quote, color: "var(--muted)" },
  ]),
);
