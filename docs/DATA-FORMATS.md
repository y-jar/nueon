# On-disk formats

Everything in a workspace is plain files; nothing is hidden or binary. This is
the contract between the Rust core, the Tauri layer and the frontend.

## Workspace layout

```
<workspace>/
  notes/                 Markdown notes (.md) and other files (images, PDFs, …)
  dictionary/            one extensionless JSON file per word table
  config/                extensionless JSON for grammar/translation/phonology
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
| `phonology` | `PhonologyConfig` | `phonemes: [{ symbol, kind }]`, `syllables`, `rules` (ordered sound changes) |

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
