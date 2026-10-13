<!-- Writing System: glyph navigator, grid, and vector editor. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { groupGlyphs, soundCoverage, compositeOutline, UNGROUPED } from "../lib/writing";
  import { confirmDialog, openGlyphContextMenu } from "../lib/state.svelte";
  import { editor, openGlyph, closeGlyph } from "../lib/writingEditor.svelte";
  import type { GuideField } from "../lib/writingMenus";
  import { deleteGlyphs, dependents, moveToGroup } from "../lib/writingBatch";
  import { save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "../lib/files";
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

  async function batchDelete(ids: string[]) {
    const outlines: Record<string, api.GlyphOutline> = {};
    for (const glyph of config.glyphs) {
      const outline = await api.writingGlyphGet(glyph.id).catch(() => null);
      if (outline) outlines[glyph.id] = outline;
    }
    const broken = dependents(outlines, ids)
      .map((id) => config.glyphs.find((g) => g.id === id)?.name ?? id);
    const confirmed = await confirmDialog({
      title: $t("writing.batchDeleteTitle"),
      message:
        broken.length > 0
          ? $t("writing.batchDeleteBroken", {
              values: { count: ids.length, names: broken.join(", ") },
            })
          : $t("writing.batchDeleteMessage", { values: { count: ids.length } }),
      confirmLabel: $t("writing.batchDelete"),
      danger: true,
    });
    if (!confirmed) return;
    config.glyphs = deleteGlyphs(config.glyphs, ids);
    if (editor.openGlyphId && ids.includes(editor.openGlyphId)) closeGlyph();
    await save();
  }

  async function batchGroup(ids: string[], group: string) {
    config.glyphs = moveToGroup(config.glyphs, ids, group);
    await save();
  }

  async function batchAdvance(ids: string[], advance: number) {
    try {
      for (const id of ids) {
        const outline = (await api.writingGlyphGet(id)) ?? { elements: [] };
        await api.writingGlyphSet(id, { ...outline, advance });
      }
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function batchExport(ids: string[]) {
    try {
      const parts: string[] = [];
      for (const id of ids) {
        const svg = await api.writingExportSvg(id);
        const name = config.glyphs.find((g) => g.id === id)?.name ?? id;
        parts.push(`<!-- ${name.replace(/--/g, "-")} -->\n${svg}`);
      }
      const path = await saveDialog({
        defaultPath: "glyphs.svg",
        filters: [{ name: "SVG", extensions: ["svg"] }],
      });
      if (!path) return;
      await writeTextFile(path, parts.join("\n"));
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function setGuide(field: GuideField, value: number) {
    config[field] = value;
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
      onDuplicate={duplicateGlyph}
      onDelete={deleteGlyph}
      onGuideChange={setGuide}
      onBatchDelete={batchDelete}
      onBatchGroup={batchGroup}
      onBatchAdvance={batchAdvance}
      onBatchExport={batchExport}
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
