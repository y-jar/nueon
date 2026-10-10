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

After a mutation the backend emits `data-changed` with a scope, and the frontend
(`src/lib/data.svelte.ts`) refreshes the matching slice:

| scope | emitted by | frontend action |
|---|---|---|
| `workspace` | workspace open/remove/rename, import | refresh workspaces, tree, index, tables |
| `notes` | note/folder create/rename/delete, asset ops, vcs checkout | refresh tree + reload open notes |
| `dictionary` | table/word/tag edits, import | reload word index + tables |
| `config` | set table role, layout/line-number/keybind prefs | reload fixes tables (and prefs) |
| `translation` | preset edits, morphology writes | (translation panel reloads) |
| `vcs` | git commits/checkouts | bump revision + reload open notes |

Any new mutating command must pick the scope whose consumers it affects and
emit it, otherwise the frontend will silently go stale.
