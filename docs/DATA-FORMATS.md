# On-disk formats

Everything in a workspace is plain files; nothing is hidden or binary. This is
the contract between the Rust core, the Tauri layer and the frontend.

## Workspace layout

```
<workspace>/
  notes/                 Markdown notes (.md) and other files (images, PDFs, …)
  dictionary/            one extensionless JSON file per word table
  config/                extensionless JSON for grammar/translation/phonology/writing
  writing/glyphs/        one extensionless JSON file per glyph outline
  writing/assets/        tracing images for the back layer (png/jpg/webp)
```

The app-global registry of known workspaces lives **outside** the workspace at
`$XDG_CONFIG_HOME/nueon/config.toml` (see `crates/nueon-core/src/global.rs`).

## Dictionary table — `dictionary/<table>`

JSON: `crates/nueon-core/src/model/table.rs` (`WordTable`).

```json
{
  "name": "lex",
  "tags": [
    { "name": "wordname", "description": "base spelling", "kind": "text", "builtin": true }
  ],
  "entries": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "wordname": "kala",
      "values": {
        "definition": { "type": "tag_list", "value": ["dog"] },
        "english":    { "type": "text",     "value": "dog" }
      }
    }
  ]
}
```

- `name` — display name.
- `tags` — columns (`TagDef`): `name`, `description`, `kind` (`text`,
  `boolean`, `tag_list`, `reference`, `references`), `builtin`, `format`
  (`default`/`multiline`/`date`/`measurement`), `suggest`. The builtin
  `wordname` tag is always present and first.
- `entries` — words (`WordEntry`): a hidden `id` (UUID, stable across rename and
  re-import), the `wordname`, and a sparse `values` map.
- A value serializes as `{ "type": <kind>, "value": <payload> }`
  (`FieldValue`, tagged enum). Payload shapes: `text`→string, `boolean`→bool,
  `tag_list`→`string[]`, `reference`→UUID, `references`→`UUID[]`.

Reserved tags with fixed meaning: `wordname`, `definition` (a `tag_list`),
`parent` (a `references`).

## Config files — `config/<name>`

| File | Type | Contents |
|---|---|---|
| `grammar` | `GrammarConfig` | `rules: [{ name, description, slots }]` — clause patterns over tag names |
| `translation` | `TranslationConfig` | `default_rule`, `settings`, `grids` (saved clause structures), `affixes`, `morphology`, `table_roles` |
| `phonology` | `PhonologyConfig` | `phonemes: [{ id, symbol, kind }]`, `syllables`, `rules` (ordered sound changes). `id` is a stable UUID, backfilled on load for pre-id configs. |
| `writing` | `WritingConfig` | `direction`, `upem`, metric guide heights, `glyphs` (index of `GlyphMeta`, each with an optional `forms` of `initial`/`medial`/`final_form` glyph ids, omitted when empty), `rules` (orthography, compiled to GSUB at export), `features` (reserved, unused) |

### `writing/glyphs/<id>` detail

Spacing: only `advance` is meaningful. Bearings are derived from the ink (left
bearing is the leftmost node, right bearing is `advance` minus the rightmost); the
`lsb` and `rsb` fields are accepted but ignored and are no longer written.

One file per glyph outline, named by the glyph's stable id (extensionless, like
tables and config). Holds a `GlyphOutline`: `elements` (a list of contours or
component instances), plus optional `advance`, `lsb`, `rsb`, and an optional
`back_image` — a tracing image on the back layer:

```json
{ "back_image": { "asset": "scan 2.png", "width": 1000, "x": 500, "y": 300 } }
```

`asset` is a bare file name inside `writing/assets/` — never a path — as the
importer wrote it; `width` is the drawn width in font units and `(x, y)` the
image's centre, y up; the height follows the file's aspect ratio, so the stored
data never depends on the image's pixel size. Files written before the field
existed load with none. The image is editor-only: the font an export writes,
its font key and the type preview all ignore it (tested byte-for-byte).

Importing copies the file into `writing/assets/`, deduping identical bytes (two
glyphs tracing the same scan share one file). Files above 10 MB import only
after the UI confirms. Deleting a glyph from the config drops its outline file
and any back-image asset no remaining outline references; clearing the image
keeps the file, so an undo restores it.

### The profile (version 3)

The profile schema version is 3. A profile bundles `language`, `phonology`,
`grammar`, `translation` and `writing` (the config index and rules only — not
the glyph outlines). v1 and v2 profiles still import; a v1/v2 file backfills a
default `writing` config.

### `config/translation` detail

- `table_roles` — map of table name → `{ role: "vocab" | "fixes", trigger?, surface? }`.
  `trigger` names the column holding the English trigger; `surface` the conlang
  surface (defaults to `wordname`). A `vocab` entry with no trigger/surface is
  omitted (vocab is the default).
- `morphology` — features (id/label/values, optional column binding) and
  paradigms (class → ordered slot/affix rows conditioned on feature values).
- `affixes` — minimal rule-based affix rules for inflected English tokens.

## Registry — `$XDG_CONFIG_HOME/nueon/config.toml`

`GlobalConfig` — the list of known workspaces (`name`, `path`) and the
`last`-used workspace. Pruned automatically when a workspace directory vanishes.
