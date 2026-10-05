# Deferred Work

Concrete features explicitly **not** implemented yet, kept here so they are not
forgotten. Add to this list instead of dropping ideas. Group items by area.

Items are tagged with the stage that will address them (D1–D7); struck items
were completed during the Tauri migration (R0–R8).

## Notes editor

- ~~Inline images and image files stored in the workspace.~~ (R7)
- ~~GFM tables, task lists (`- [ ]`), footnotes, HTML blocks, inline/display math.~~ (R7)
- Cross-block keyboard navigation (Up/Down across region boundaries, Home/End).
- ~~Find/replace within a note.~~ (R7)
- ~~Optional debounced disk writes (currently every keystroke).~~ (R7)
- ~~Cache the dictionary word index (currently rebuilt on each rendered frame).~~ (R7)
- Inline/display **math via KaTeX** rendering. (D7)
- HTML block rendering. (D7)

## Dictionary grid

- Persist hidden columns / sort / filter state across restarts. (D1)
- Per-column filter / search / column-hide UI. (D1)
- Misspelling guard for `definition` fields against a standard dependency
  dictionary (PSD §B); never applied to `wordname`. (D1)
- Tag management UI: add/remove tags on a word, tag suggestion dropdown when
  adding a tag (backend `known_tag_names` exists). (D1)
- Bulk edit / multi-select of rows. (D1)
- Field-type editing or migration after tags are created. (D1)
- Rich cell editors for `TagList` (currently display-only in the grid);
  reference cells are display-only (edit via the inspector parent picker). (D1)

## Etymology / derivation

- Graphical ancestor/descendant tree (current inspector is a text list). (D2)
- Re-parenting without removing the old parent in one step. (D2)
- Manual-convert option to **reassign** a dependent to a different parent
  (current manual delete only unlinks/optionally deletes). (D2)
- Export a derivation tree to a note/file. (D2)
- Warn when changing a tag value that other rules depend on (beyond wordname). (D2)

## Translation engine

- Multi-clause / sentence-level grids (current grids are a single clause). (D3)
- Morphology: inflection, agreement, and tense transforms. (D3)
- Smarter English tokenization / lemmatization (plurals, tense, stopwords). (D3)
- Per-slot custom spacer text (a `Spacer` currently emits the global separator). (D3)
- Import/export presets. (D3)

## Version control

- ~~Per-file diff / revert / show in the Source Control panel.~~ (R6)
- Commit on application close. (D4)
- Branch display/switching, remotes, push/pull. (D4)
- Conflict handling and resolution. (D4)
- "Don't show again" for the git init/install prompt. (D4)

## Workspace & app shell

- Window size and dock layout persistence. (D5)
- Settings screen (language metadata editor, script/direction rendering). (D5)
- Grammar rules editor UI (`config/grammar`); expose `config_get`/`config_set`
  commands to the frontend. (D5)
- ~~Nix flake for packaging, app icon, `.desktop` entry.~~ (R8)
- ~~Internationalization.~~ (D0)

## Data model

- **Per-tag field formatting/widget hints** on `TagDef`: a format enum so the
  UI knows how to render/edit a tag's data (e.g. reference links, dates,
  measurements, multi-line text). Motivated by the note that "tag field data can
  be formatted in different ways". (D6)
- Non-JSON storage formats per table (if ever needed). (D6)
- Undo/redo history for dictionary edits. (D6)
- One-time warnings with a "don't show again" checkbox (tag removal,
  dependency warnings). (D6)
