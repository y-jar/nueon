<!-- Writing System: glyph navigator, grid, and vector editor. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { groupGlyphs, soundCoverage, compositeOutline, UNGROUPED } from "../lib/writing";
  import { openGlyphContextMenu } from "../lib/state.svelte";
  import { editor, openGlyph, closeGlyph } from "../lib/writingEditor.svelte";
  import GlyphNavigatorTree from "./GlyphNavigatorTree.svelte";
  import GlyphGrid from "./GlyphGrid.svelte";
  import VectorEditor from "./VectorEditor.svelte";

  let config = $state<api.WritingConfig>({
    direction: "ltr",
    upem: 1000,
    x_height: 0,
    cap_height: 0,
    ascender: 0,
    descender: 0,
    glyphs: [],
    rules: [],
    features: "",
  });
  let phonemes = $state<api.Phoneme[]>([]);
  let selectedGroup = $state<string | null>(null);
  let error = $state("");

  const groups = $derived(groupGlyphs(config.glyphs));
  const coverage = $derived(
    soundCoverage(
      config.glyphs,
      phonemes.map((p) => p.id ?? p.symbol),
    ),
  );
  const coveredIds = $derived(new Set(config.glyphs.flatMap((g) => g.phonemes)));
  const editing = $derived(editor.openGlyphId !== null);

  onMount(load);

  async function load() {
    try {
      config = await api.writingGet();
      const ph = await api.phonologyGet();
      phonemes = ph.phonemes ?? [];
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function save() {
    try {
      await api.writingSet(config);
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function addGlyph() {
    config.glyphs = [
      ...config.glyphs,
      {
        id: crypto.randomUUID(),
        name: `glyph-${config.glyphs.length + 1}`,
        codepoint: 0xe000 + config.glyphs.length,
        phonemes: [],
        order: config.glyphs.length,
        group: UNGROUPED,
      },
    ];
    void save();
  }

  function addGlyphFor(phoneme: api.Phoneme) {
    const group =
      phoneme.kind === "vowel"
        ? "vowels"
        : phoneme.kind === "consonant"
          ? "consonants"
          : "other";
    config.glyphs = [
      ...config.glyphs,
      {
        id: crypto.randomUUID(),
        name: phoneme.symbol,
        codepoint: 0xe000 + config.glyphs.length,
        phonemes: [phoneme.id ?? phoneme.symbol],
        order: config.glyphs.length,
        group,
      },
    ];
    void save();
  }

  function duplicateGlyph(id: string) {
    const source = config.glyphs.find((g) => g.id === id);
    if (!source) return;
    config.glyphs = [
      ...config.glyphs,
      {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} copy`,
        order: config.glyphs.length,
      },
    ];
    void save();
  }

  function deleteGlyph(id: string) {
    config.glyphs = config.glyphs.filter((g) => g.id !== id);
    if (editor.openGlyphId === id) closeGlyph();
    void save();
  }

  function selectGlyph(glyph: api.GlyphMeta) {
    openGlyph(glyph.id, glyph);
  }

  async function composeGlyph(row: api.GlyphMeta, col: api.GlyphMeta) {
    const meta: api.GlyphMeta = {
      id: crypto.randomUUID(),
      name: `${row.name}+${col.name}`,
      codepoint: 0xe000 + config.glyphs.length,
      phonemes: [],
      order: config.glyphs.length,
      group: "composed",
    };
    config.glyphs = [...config.glyphs, meta];
    try {
      await api.writingSet(config);
      await api.writingGlyphSet(meta.id, compositeOutline(row.id, col.id));
      error = "";
      openGlyph(meta.id, meta);
    } catch (e) {
      error = String(e);
    }
  }

  function onMenu(event: MouseEvent, glyph: api.GlyphMeta) {
    openGlyphContextMenu(event.clientX, event.clientY, {
      id: glyph.id,
      name: glyph.name,
      onEdit: () => openGlyph(glyph.id, glyph),
      onDuplicate: () => duplicateGlyph(glyph.id),
      onDelete: () => deleteGlyph(glyph.id),
    });
  }
</script>

<div class="writing">
  <header class="writing-bar">
    <span class="pane-title">{$t("writing.title")}</span>
    <span class="muted">
      {$t("writing.mapped", { values: { mapped: coverage.mapped, total: coverage.total } })}
    </span>
    <span class="grow"></span>
    <button onclick={addGlyph}><Plus size={14} /> {$t("writing.addGlyph")}</button>
  </header>

  {#if error}<p class="error">{error}</p>{/if}

  {#if editing}
    <VectorEditor
      {config}
      {phonemes}
      onClose={closeGlyph}
      onOpen={selectGlyph}
      onAdd={addGlyph}
      onCompose={composeGlyph}
    />
  {:else}
    {#if config.glyphs.length === 0}
      <p class="muted">{$t("writing.empty")}</p>
    {/if}

    <div class="writing-body">
      <GlyphNavigatorTree
        groups={groups}
        {phonemes}
        {coveredIds}
        {selectedGroup}
        onSelectGroup={(g) => (selectedGroup = g)}
        onAddFor={addGlyphFor}
      />
      <GlyphGrid
        glyphs={selectedGroup ? (groups.get(selectedGroup) ?? []) : config.glyphs}
        {phonemes}
        selectedId={editor.openGlyphId}
        onSelect={selectGlyph}
        {onMenu}
      />
    </div>
  {/if}
</div>
