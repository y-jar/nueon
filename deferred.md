# Deferred Work

Concrete features explicitly **not** implemented yet, kept here so they are not
forgotten. Add to this list instead of dropping ideas. Group items by area.

## Notes editor

- Clickable links (open in browser via `egui::open_url`) and link tooltips.
- Inline images and image files stored in the workspace.
- GFM tables, task lists (`- [ ]`), footnotes, HTML blocks, inline/display math.
- Cross-block keyboard navigation (Up/Down across region boundaries, Home/End).
- Per-note scroll position memory.
- Find/replace within a note.
- Highlight dictionary words in rendered text; hover shows the definition
  preview (PSD §A: database integration in the editor).
- Homograph superscripts (`word¹`, `word²`) in editor and inspector.
- Optional debounced disk writes (currently every keystroke).

## Dictionary grid

- Persist hidden columns / sort / filter state across restarts.
- Misspelling guard for `definition` fields against a standard dependency
  dictionary (PSD §B); never applied to `wordname`.
- Tag suggestion dropdown when adding a tag (backend `known_tag_names` exists).
- Bulk edit / multi-select of rows.
- Field-type editing or migration after tags are created.
- Rich cell editors for `TagList` (currently display-only in the grid);
  reference cells are display-only (edit via the inspector parent picker).

## Etymology / derivation

- Graphical ancestor/descendant tree (current inspector is a text list).
- Re-parenting without removing the old parent in one step.
- Manual-convert option to **reassign** a dependent to a different parent
  (current manual delete only unlinks/optionally deletes).
- Export a derivation tree to a note/file.
- Warn when changing a tag value that other rules depend on (beyond wordname).

## Translation engine

- English→conlang execution: tokenize input, look up equivalents via
  `definition`, and map words into the grid's slots.
- Conflict resolution when an English word maps to multiple conlang words
  (homographs).
- Inline creation of missing words from the translation view.
- Multi-clause / sentence-level grids (current grids are a single clause).
- Morphology: inflection, agreement, and tense transforms.
- Import/export presets.

## Version control

- Per-file diff / revert / show in the Source Control panel (backend
  `diff_stat` and `show` exist).
- Commit on application close.
- Branch display/switching, remotes, push/pull.
- Conflict handling and resolution.
- "Don't show again" for the git init/install prompt.

## Workspace & app shell

- Native "Open / Create workspace" file picker (`rfd`).
- Window size and dock layout persistence (eframe storage).
- Create / rename / delete notes and folders from the sidebar.
- Settings screen (language metadata editor, script/direction rendering).
- Grammar rules editor UI (`config/grammar`).
- Nix flake for packaging, app icon, `.desktop` entry.
- Internationalization.

## Data model

- **Per-tag field formatting/widget hints** on `TagDef`: a format enum so the
  UI knows how to render/edit a tag's data (e.g. reference links, dates,
  measurements, multi-line text). Motivated by the note that "tag field data can
  be formatted in different ways".
- Non-JSON storage formats per table (if ever needed).
- Undo/redo history for dictionary edits.
- One-time warnings with a "don't show again" checkbox (tag removal,
  dependency warnings).
