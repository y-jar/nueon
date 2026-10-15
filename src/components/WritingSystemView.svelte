<!-- Writing System: glyph navigator, grid, and vector editor. -->
<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import * as api from "../lib/api";
  import {
    groupGlyphs,
    soundCoverage,
    compositeOutline,
    nextCodepoint,
    UNGROUPED,
  } from "../lib/writing";
  import { confirmDialog, openGlyphContextMenu, ui } from "../lib/state.svelte";
  import { editor, openGlyph, closeGlyph } from "../lib/writingEditor.svelte";
  import type { GuideField } from "../lib/writingMenus";
  import { deleteGlyphs, dependents, moveToGroup } from "../lib/writingBatch";
  import { save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { writeTextFile } from "../lib/files";
  import GlyphNavigatorTree from "./GlyphNavigatorTree.svelte";
  import GlyphGrid from "./GlyphGrid.svelte";
  import GlyphGridControls from "./GlyphGridControls.svelte";
  import { createOutlineCache } from "../lib/outlineCache";
  import {
    CELL_SIZES,
    buildCells,
    clampCell,
    progressOf,
    shouldApplyReload,
    type GridFilter,
  } from "../lib/writingGrid";
  import { guideHeight } from "../lib/writing";
  import OrthographyRules from "./OrthographyRules.svelte";
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

  const cache = createOutlineCache((id) => api.writingGlyphGet(id), 6);
  let cacheVersion = $state(0);
  const offCache = cache.onChange(() => (cacheVersion = cache.version()));
  onDestroy(offCache);

  let cellSize = $state<number>(CELL_SIZES.M);
  let filter = $state<GridFilter>({ group: null, sound: "all", fill: "all", text: "" });
  const gridFilter = $derived<GridFilter>({ ...filter, group: selectedGroup });

  const outlinesNow = $derived.by(() => {
    cacheVersion;
    const out: Record<string, api.GlyphOutline | null | undefined> = {};
    for (const g of config.glyphs) out[g.id] = cache.get(g.id);
    return out;
  });
  const cells = $derived(buildCells(config.glyphs, phonemes, outlinesNow, gridFilter));
  const progress = $derived(progressOf(config.glyphs, phonemes, outlinesNow));

  function lookup(id: string): api.GlyphOutline | null {
    cache.request([id]);
    return cache.get(id) ?? null;
  }

  let wantedIds = new Set<string>();
  function onVisible(ids: string[]) {
    const fresh = ids.filter((id) => !wantedIds.has(id));
    wantedIds = new Set(ids);
    if (fresh.length > 0) cache.request(ids);
  }

  // Every outline is needed once to tell drawn from empty for the progress line.
  $effect(() => {
    const ids = config.glyphs.map((g) => g.id);
    untrack(() => cache.request(ids));
  });

  // Anything that changes the writing or phonology config (the editor, another
  // panel, a git checkout) bumps a revision: reload the config and refresh previews.
  let seenRevision = `${ui.writingRevision}:${ui.phonologyRevision}`;
  $effect(() => {
    const now = `${ui.writingRevision}:${ui.phonologyRevision}`;
    untrack(() => {
      if (now === seenRevision) return;
      seenRevision = now;
      cache.invalidate();
      void load().then(() => cache.request(config.glyphs.map((g) => g.id)));
    });
  });

  function createForPhoneme(phoneme: api.Phoneme) {
    addGlyphFor(phoneme);
    const made = config.glyphs[config.glyphs.length - 1];
    if (made) openGlyph(made.id, made);
  }

  onMount(load);

  async function load() {
    try {
      const loaded = await api.writingGet();
      const ph = await api.phonologyGet();
      if (shouldApplyReload(config, loaded, pendingSave)) config = loaded;
      phonemes = ph.phonemes ?? [];
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  let pendingSave = false;

  async function save() {
    pendingSave = true;
    try {
      await api.writingSet(config);
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      pendingSave = false;
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function changeRules(rules: api.OrthographyRule[]) {
    config.rules = rules;
    clearTimeout(saveTimer);
    pendingSave = true;
    saveTimer = setTimeout(() => void save(), 400);
  }

  function addGlyph() {
    config.glyphs = [
      ...config.glyphs,
      {
        id: crypto.randomUUID(),
        name: `glyph-${config.glyphs.length + 1}`,
        codepoint: nextCodepoint(config.glyphs) ?? 0xe000,
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
        codepoint: nextCodepoint(config.glyphs) ?? 0xe000,
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

  function changeGlyph(glyph: api.GlyphMeta) {
    config.glyphs = config.glyphs.map((g) => (g.id === glyph.id ? glyph : g));
    void save();
  }

  function selectGlyph(glyph: api.GlyphMeta) {
    openGlyph(glyph.id, glyph);
  }

  async function composeGlyph(row: api.GlyphMeta, col: api.GlyphMeta) {
    const meta: api.GlyphMeta = {
      id: crypto.randomUUID(),
      name: `${row.name}+${col.name}`,
      codepoint: nextCodepoint(config.glyphs) ?? 0xe000,
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
    {#if !editing}
      <button onclick={addGlyph}><Plus size={14} /> {$t("writing.addGlyph")}</button>
    {/if}
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
      onGlyphChange={changeGlyph}
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
      <div class="glyph-pane">
        <GlyphGridControls
          {filter}
          {cellSize}
          {progress}
          shown={cells.length}
          onFilter={(next) => (filter = next)}
          onSize={(px) => (cellSize = clampCell(px))}
        />
        <GlyphGrid
          {cells}
          outlineOf={(id) => cache.get(id)}
          {lookup}
          {cellSize}
          selectedId={editor.openGlyphId}
          ascender={guideHeight(config, "ascender")}
          descender={guideHeight(config, "descender")}
          version={cacheVersion}
          {onVisible}
          onSelect={selectGlyph}
          onCreate={createForPhoneme}
          {onMenu}
        />
      </div>
    </div>
    <OrthographyRules rules={config.rules} glyphs={config.glyphs} onChange={changeRules} />
  {/if}
</div>
