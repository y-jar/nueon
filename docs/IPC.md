# Tauri IPC

The full command surface between the Svelte frontend and the Rust core. The
frontend wrappers live in `src/lib/api.ts`; the command handlers in
`src-tauri/src/commands/*.rs`. `data-changed` events keep the frontend in sync;
the scope table is at the end.

## Workspace & lifecycle

`workspace_list`, `workspace_current`, `workspace_open`, `workspace_create`,
`workspace_remove`, `workspace_rename`, `workspace_set_path`,
`workspace_delete_from_disk`, `config_get`, `config_set`, `profile_export`,
`profile_import`, `export_workspace_zip`, `workspace_import_zip`, `undo`, `redo`,
`recent_record`, `recent_list`.

## Notes & files

`list_workspace`, `read_note`, `save_note`, `create_note`,
`create_note_with_content`, `create_folder`, `move_or_rename_note`,
`delete_note`, `note_count`, `import_asset`, `copy_into_notes`, `export_document`.

## Dictionary

`word_index`, `list_tables`, `quarantine_warnings`, `get_table`, `create_table`,
`delete_table`, `rename_table`, `create_word`, `save_word_entry`,
`set_word_value`, `set_words_value`, `set_word_definition`, `rename_word`,
`delete_word`, `add_tag`, `remove_tag`, `remove_tag_preview`, `set_tag_kind`,
`set_tag_format`, `set_tag_suggest`, `known_tag_names`, `grid_view_get`,
`grid_view_set`, `set_parent`, `remove_parent`, `reparent_word`,
`parent_candidates`, `derivation_tree`, `derivation_graph`.

## Import & export

`import_detect`, `import_preview`, `import_apply`, `export_table`, `export_anki`,
`export_presets`, `import_presets`.

## Translation

`list_presets`, `save_preset`, `delete_preset`, `execute_translation`,
`execute_translation_direct`, `translation_suggest`, `translation_options`,
`set_translation_options`, `translation_morphology`, `set_translation_morphology`,
`create_translation_word`.

## Morphology

`list_morphemes`, `lexicon`, `class_column_get`, `normalize_class_values`,
`inflect_word`, `feature_values`, `paradigm_grid`, `compose`, `table_roles_get`,
`set_table_role`.

## Phonology

`phonology_check_words`, `phonology_segments`, `phonology_apply_word`,
`phonology_apply_table`.

## File paths

Every filesystem path is chosen on the Rust side: the dialogs run there (the
callback API, so no thread blocks), and the I/O functions that take a path are
plain and unit-tested (`src-tauri/src/security.rs`: the 8 MB read cap, the
50 MB write cap, extension checks). Removed outright: `read_text_file`,
`write_text_file`, `writing_export_font`, `writing_back_image_import`,
`export_document`, `export_presets`, `import_presets`, `profile_export`,
`profile_import`, `export_workspace_zip`, `workspace_import_zip`,
`import_detect`, `import_preview`, `export_table`, `export_anki` — all took a
path from JavaScript. `import_asset` and `copy_into_notes` remain for OS
drag-dropped files only: the drag-drop handler records the dropped paths as
one-use grants, and both commands consume a grant or refuse. The dialog
commands: `writing_import_svg_dialog`, `writing_export_svg_dialog`,
`writing_export_text_dialog` (app-generated SVG text),
`writing_export_font_dialog` (+ `writing_font_bytes`, the same compiled bytes
in memory, for tests and probes), `asset_import_dialog`,
`export_document_dialog` (PDF/ODT), `export_presets_dialog` /
`import_presets_dialog`, `profile_export_dialog` / `profile_import_dialog`,
`export_workspace_zip_dialog` (zips to a temp file beside the destination,
then moves it into place) / `workspace_import_zip_dialog` (both the zip and the
parent directory are picked in Rust), `import_pick_dialog` (picks the import
file, reads and detects it, stashes the path for the wizard's
`import_detect_again` / `import_preview_stashed` / `import_apply`, which
replaces the plan's `source` with the stashed path; `import_cancel` forgets
it), `export_table_dialog`, `export_anki_dialog`,
`workspace_open_dialog` (picks the folder) and `workspace_create_dialog`
(picks the parent). `workspace_open` stays for opening a workspace from the
registry list the backend produced, and refuses a path that is not registered;
`workspace_remove`, `workspace_rename` and `workspace_delete_from_disk`
refuse unregistered paths the same way.

## Writing system

`writing_glyph_get`, `writing_glyph_set` (per-glyph outline load/save), and
`writing_path_operation` (pathfinder booleans over a glyph's flattened contours:
`union`, `difference`, `intersect`, `exclude`), `writing_export_svg` (one glyph
as an SVG document), `writing_export_sprite` (every glyph as a `<symbol>`
sprite sheet) and `writing_import_svg` (replace a glyph's contours from SVG
text; supports `M L H V C Q Z`) and `writing_export_font` (compile every glyph
to a TrueType font, verify it by reading it back, write it to a chosen path;
returns `{ glyphs, mapped, bytes, source_glyphs, lookups }`; it refuses to
run while the check reports an error) and `writing_validate_font` (check every glyph without
writing anything; returns `FontIssue[]` of `{ glyph, name, severity, code,
message }`, severity `error`, `warning` or `info`). `writing_preview_shape` (shape lines of text against the compiled font for the
type preview: takes `lines` and `rtl`, returns `{ key, glyph_ids, runs }` where each
run lists `{ id, cluster, advance, x_offset, y_offset }` per glyph in visual order;
the compiled font is cached by `key`). `writing_back_image_import` (import a
tracing image for a glyph: takes `id`, `path` and `force`, sniffs png/jpg/webp
bytes, copies the file into `writing/assets/` (deduping identical bytes), sets
it as the glyph's `back_image` fitted to the em box, returns the
`{ asset, width, x, y }` reference) and `writing_back_image_path` (the absolute
path of a glyph's back image file, or null, for the webview's asset URL). Both
bump the `writing` data-changed scope. `writing_back_image_dialog` (pick a
tracing image in a dialog run on the Rust side and import it; a file over
10 MB stashes the picked path so `writing_back_image_confirm` can retry it
with force after the UI's warning, without re-picking). The writing config
itself travels through the generic `config_get`/`config_set` with section
`writing`.

## Version control

`vcs_state`, `vcs_status`, `vcs_log`, `vcs_diff`, `vcs_show`, `vcs_branches`,
`vcs_checkout`, `vcs_create_branch`, `vcs_commit`, `vcs_init`, `vcs_revert_file`,
`git_prompt_dismissed`, `git_prompt_dismissed_set`, `autocheckin_get`,
`autocheckin_set`, `autocheckin_pump`.

## Trash, keybinds & prefs

`trash_list`, `trash_restore`, `trash_purge`, `trash_empty`, `keybinds_get`,
`set_keybind`, `reset_keybinds`, `editor_line_numbers`, `set_editor_line_numbers`,
`suppressed_confirms`, `suppress_confirm`, `clear_suppressed_confirms`,
`warning_dismissed`, `dismiss_warning`, `ui_layout_get`, `ui_layout_set`,
`layout_state_get`, `tiling_save`.

## Windows

`window_spawn`, `window_close_self`, `window_geometry`, `windows_restore`,
`secondary_labels`, `destroy_windows`.

## The `data-changed` event

After a mutation the backend emits `data-changed` with a scope, and the
frontend routes it through the invalidation registry
(`src/lib/invalidation.svelte.ts`): consumers declare the scopes that
invalidate the data they hold; visible ones reload (debounced 150 ms, so a
burst coalesces), hidden ones go stale and reload when shown, and a
consumer's own writes are skipped for it alone — exactly one echo event per
write, so later events still reload. The registry also bumps the per-scope
`ui.revision` counter that effect-based consumers read.

| scope | emitted by (sites) | frontend action |
|---|---|---|
| `workspace` (8) | workspace open/create/remove/rename/set-path/delete-from-disk, zip import | reload workspaces, tree, word index, fixes tables, tables; registered consumers (morphology) reload |
| `notes` (17) | note/folder create/rename/delete, asset import/copy/drop, word-rename link rewrite, `phonology_apply_table`, `import_apply`, trash restore (note), workspace create/open, vcs checkout/revert, undo/redo (when the step rewrote note files) | refresh tree + reload open notes |
| `dictionary` (25) | table/word/tag edits (18), undo/redo, `create_translation_word`, `normalize_class_values`, `phonology_apply_table`, `import_apply`, trash restore (table), vcs checkout | reload word index + tables; registered consumers (morphology) reload |
| `config` (4) | `config_set` (any section: language/grammar/phonology/writing/translation), `set_table_role`, `profile_import`, vcs checkout/revert | reload fixes tables; bump `ui.revision.config` (phonology, writing views, Inspector, Translation, ParadigmGrid) and registered consumers (morphology) reload |
| `translation` (4) | preset save/delete, `set_translation_morphology`, `set_translation_options` | bump `ui.revision.translation` (the Translation panel, ParadigmGrid) and reload the morphology store |
| `writing` (8) | glyph outline save, path ops, back image, SVG import, SVG/font export | bump `ui.revision.writing` (writing views refetch) |
| `vcs` (7) | commit, checkout, branch, init, revert, prompt dismiss, autocheck-in pump | bump `ui.revision.vcs` (Source Control panel) + reload open notes |

Checkout and revert go through `changed_after_disk_change`, which fires
notes + dictionary + config + vcs (a checkout can rewrite any file). Undo and
redo fire `dictionary`, plus `notes` when the applied step rewrote note files
(a rename's link rewrite). Remaining no-emit commands, flagged by the audit:
`save_note` (an open note in a second window goes stale), `grid_view_set`,
`ui_layout_set`, `tiling_save`, `window_spawn`, `dismiss_warning`,
`suppress_confirm`, `clear_suppressed_confirms`, `set_editor_line_numbers`,
`set_keybind`, `reset_keybinds`, `recent_record`, `trash_purge`,
`trash_empty` — the pref/layout ones are single-window by design; `save_note`
is a real gap.

Any new mutating command must pick the scope whose consumers it affects and
emit it, otherwise the frontend will silently go stale. Any new store or
panel that caches backend data must register the scopes that invalidate it
(`registerInvalidation`) or read the matching `ui.revision` counter, and a
probe must cover at least one change of each declared scope.
