# Deferred Work

Concrete features explicitly **not** implemented yet, kept here so they are not
forgotten. Add to this list instead of dropping ideas. Group items by area.

Items are tagged with the stage that addresses them. Struck items show the
stage that completed them: `R0`–`R8` were done during the Tauri migration,
`D0`–`D7` after it.

## Notes editor

- ~~Inline images and image files stored in the workspace.~~ (R7)
- ~~GFM tables, task lists (`- [ ]`), footnotes.~~ (R7)
- ~~Cross-block keyboard navigation (Up/Down across region boundaries,
  Home/End): arrow navigation enters a rendered table, math or HTML block and
  reveals its raw text rather than stepping over it.~~ (probe 9)
- ~~Find/replace within a note.~~ (R7)
- ~~Optional debounced disk writes (currently every keystroke).~~ (R7)
- ~~Cache the dictionary word index (currently rebuilt on each rendered frame).~~ (R7)
- ~~Inline/display **math via KaTeX** rendering.~~ (D7)
- ~~HTML block rendering.~~ (D7)
- Tables inside blockquotes and list items aren't editable with the table
  commands (raw editing only); handle the line prefix later if needed.

## Note links

Shipped: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
`[[target#heading|alias]]`, `!` embeds, the ranked dropdown, a link keybind,
hidden brackets that reveal on the cursor, and link rewriting on rename.

- Block links (`[[note#^block-id]]`) are out of scope.
- Setext headings (`===` / `---` underlines) are not resolved by
  `[[note#heading]]`; only ATX headings (`#` through `######`) are.
- Heading embeds (`![[note#heading]]`) render like a note embed without
  heading-specific display.

## Dictionary grid

- ~~Persist hidden columns / sort / filter state across restarts.~~ (D1)
- ~~Per-column filter / search / column-hide UI.~~ (D1)
- ~~Misspelling guard for `definition` fields against a standard dependency
  dictionary (PSD §B); never applied to `wordname`.~~ (D1, nspell)
- ~~Tag management UI: add/remove tags on a word, tag suggestion dropdown when
  adding a tag (backend `known_tag_names` exists).~~ (D1)
- ~~Multi-select of rows with bulk delete.~~ (D1)
- ~~Bulk value edit: apply one value to every selected row at once.~~ (bulk edit)
- ~~Field-type editing or migration after tags are created.~~ (D1)
- ~~Rich cell editors for `TagList`; reference cells are display-only (edit via
  the inspector parent picker).~~ (D1)

## Etymology / derivation

- ~~Graphical ancestor/descendant tree (current inspector is a text list).~~ (D2)
- ~~Re-parenting without removing the old parent in one step.~~ (D2)
- ~~Manual-convert option to **reassign** a dependent to a different parent
  (current manual delete only unlinks/optionally deletes).~~ (dependent-aware delete)
- ~~Export a derivation tree to a note/file.~~ (D2)
- Warn when changing a tag value that other rules depend on (beyond wordname). (D2+)

## Translation engine

- Multi-clause / sentence-level grids (current grids are a single clause). (D3+)
- ~~Morphology: inflection, agreement, and tense transforms.~~ (D3, minimal rule-based affixes)
- ~~Smarter English tokenization / lemmatization (plurals, tense, stopwords).~~ (D3)
- ~~Per-slot custom spacer text (a `Spacer` currently emits the global separator).~~ (D3)
- ~~Import/export presets.~~ (D3)

## Version control

- ~~Per-file diff / revert / show in the Source Control panel.~~ (R6, show in D4)
- ~~Commit on application close.~~ (D4)
- ~~Branch display/switching.~~ (D4)
- Remotes, push/pull. (D4+)
- Conflict handling and resolution. (D4+)
- ~~"Don't show again" for the git init/install prompt.~~ (D4)
- Idle auto check-in only fires on app close. `autocheckin_pump` is never
  invoked from the frontend during a session, so mid-session idle commits do
  not happen. (dead-code audit)

## Workspace & app shell

- ~~Window size and dock layout persistence.~~ (D5)
- ~~Settings screen (language metadata editor, script/direction rendering).~~ (D5)
- ~~Grammar rules editor UI (`config/grammar`); expose `config_get`/`config_set`
  commands to the frontend.~~ (D5)
- ~~Nix flake for packaging, app icon, `.desktop` entry.~~ (R8)
- ~~Internationalization.~~ (D0)
- Workspace management UI: the backend supports rename, remove, repoint
  (`workspace_set_path`) and delete-from-disk (`workspace_delete_from_disk`),
  but the shell never calls them, so a workspace cannot be renamed or removed
  from the UI despite the README claiming it can. (dead-code audit)

## Tabs

Shipped: reveal-on-activate (no scrollbar), title tooltips, `aria-selected`
with roving tabindex and arrow/Home/End navigation, `Ctrl+Tab` /
`Ctrl+PageDown` next and `Ctrl+PageUp` previous, close others/all, and a `+`
new-note button.

- Tab **overflow dropdown** ("all tabs", VS Code style) when the tabs exceed
  the strip; only inline scroll + reveal exists today, so a heavily populated
  strip gives no way to jump to a tab by name.
- **"Close to the right"** tab action.
- Cosmetic: the drag drop-indicators (`inset ±3px` box-shadows) can be clipped
  at the strip's overflow edges.

## Data model

- ~~**Per-tag field formatting/widget hints** on `TagDef` (`TagFormat`).~~ (D6)
- Non-JSON storage formats per table (if ever needed). (D6+)
- ~~Undo/redo history for dictionary edits.~~ (D6, backend snapshots)
- ~~One-time warnings with a "don't show again" checkbox (tag removal,
  dependency warnings).~~ (D6)

## Quality-of-life add-ons

- ~~Quick-add "Draft Word" stubs from the translation builder.~~
- ~~Rule-Based Affix & Declension Engine (ordered multi-slot affixes, fixes-table
  morphemes, feature/slot authoring, and an Inflect preview).~~ (Morphology)
- ~~Interactive Phonology & IPA Chart with Sound Change Engine (SCA).~~
  (Morphology/SCA)
- ~~Automatic Interlinear Gloss Generator (Leipzig rules) + clipboard exports.~~

## Morphology (next)

- Agreement: let one word's feature values follow another's (e.g. adjective ↔
  noun number/case).
- Allomorphy / conditioning: pick an affix variant by the stem's shape or the
  surrounding features (e.g. `-i` after a consonant, `-y` after a vowel).
- A declension/conjugation reference table per class in the Inspector.
- ~~Cross-table parent links: Compose only links roots in the chosen save table;
  roots from another table are listed as "different table, not linked". The
  backend already stores parents by UUID, so cross-table links are possible.~~
