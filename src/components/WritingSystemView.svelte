<!-- Writing System: glyph navigator and grid. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { groupGlyphs, soundCoverage, UNGROUPED } from "../lib/writing";
  import { openGlyphContextMenu } from "../lib/state.svelte";
  import GlyphNavigatorTree from "./GlyphNavigatorTree.svelte";
  import GlyphGrid from "./GlyphGrid.svelte";

  let glyphs = $state<api.GlyphMeta[]>([]);
  let direction = $state<api.WritingDirection>("ltr");
  let upem = $state(1000);
  let xHeight = $state(0);
  let capHeight = $state(0);
  let ascender = $state(0);
  let descender = $state(0);
  let rules = $state<api.OrthographyRule[]>([]);
  let features = $state("");

  let phonemes = $state<api.Phoneme[]>([]);
  let selectedGroup = $state<string | null>(null);
  let selectedGlyphId = $state<string | null>(null);
  let error = $state("");

  const groups = $derived(groupGlyphs(glyphs));
  const coverage = $derived(
    soundCoverage(
      glyphs,
      phonemes.map((p) => p.id ?? p.symbol),
    ),
  );
  const coveredIds = $derived(new Set(glyphs.flatMap((g) => g.phonemes)));

  onMount(load);

  async function load() {
    try {
      const config = await api.writingGet();
      glyphs = config.glyphs ?? [];
      direction = config.direction ?? "ltr";
      upem = config.upem ?? 1000;
      xHeight = config.x_height ?? 0;
      capHeight = config.cap_height ?? 0;
      ascender = config.ascender ?? 0;
      descender = config.descender ?? 0;
      rules = config.rules ?? [];
      features = config.features ?? "";
      const ph = await api.phonologyGet();
      phonemes = ph.phonemes ?? [];
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function save() {
    try {
      await api.writingSet({
        direction,
        upem,
        x_height: xHeight,
        cap_height: capHeight,
        ascender,
        descender,
        glyphs,
        rules,
        features,
      });
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function addGlyph() {
    glyphs = [
      ...glyphs,
      {
        id: crypto.randomUUID(),
        name: `glyph-${glyphs.length + 1}`,
        codepoint: 0xe000 + glyphs.length,
        phonemes: [],
        order: glyphs.length,
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
    glyphs = [
      ...glyphs,
      {
        id: crypto.randomUUID(),
        name: phoneme.symbol,
        codepoint: 0xe000 + glyphs.length,
        phonemes: [phoneme.id ?? phoneme.symbol],
        order: glyphs.length,
        group,
      },
    ];
    void save();
  }

  function duplicateGlyph(id: string) {
    const source = glyphs.find((g) => g.id === id);
    if (!source) return;
    glyphs = [
      ...glyphs,
      {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} copy`,
        order: glyphs.length,
      },
    ];
    void save();
  }

  function deleteGlyph(id: string) {
    glyphs = glyphs.filter((g) => g.id !== id);
    if (selectedGlyphId === id) selectedGlyphId = null;
    void save();
  }

  function editGlyph(id: string) {
    selectedGlyphId = id;
  }

  function onMenu(event: MouseEvent, glyph: api.GlyphMeta) {
    openGlyphContextMenu(event.clientX, event.clientY, {
      id: glyph.id,
      name: glyph.name,
      onEdit: () => editGlyph(glyph.id),
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

  {#if glyphs.length === 0}
    <p class="muted">{$t("writing.empty")}</p>
  {/if}

  <div class="writing-body">
    <GlyphNavigatorTree
      {groups}
      {phonemes}
      {coveredIds}
      {selectedGroup}
      onSelectGroup={(g) => (selectedGroup = g)}
      onAddFor={addGlyphFor}
    />
    <GlyphGrid
      glyphs={selectedGroup ? (groups.get(selectedGroup) ?? []) : glyphs}
      {phonemes}
      selectedId={selectedGlyphId}
      onSelect={(g) => (selectedGlyphId = g.id)}
      {onMenu}
    />
  </div>
</div>
