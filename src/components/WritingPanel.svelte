<!-- Writing System activity: searchable glyph list with sound coverage. -->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { Search } from "@lucide/svelte";
  import * as api from "../lib/api";
  import { ui } from "../lib/state.svelte";
  import { openGlyph } from "../lib/writingEditor.svelte";
  import { sidebarCoverage, sidebarGroups } from "../lib/writingSidebar";

  let glyphs = $state<api.GlyphMeta[]>([]);
  let phonemes = $state<api.Phoneme[]>([]);
  let filter = $state("");
  let error = $state("");

  const groups = $derived(sidebarGroups(glyphs, phonemes, filter));
  const coverage = $derived(sidebarCoverage(glyphs, phonemes));

  async function load() {
    try {
      const config = await api.writingGet();
      glyphs = config.glyphs ?? [];
      phonemes = (await api.phonologyGet()).phonemes ?? [];
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  onMount(() => void load());

  // The writing tab saves through config_set, which bumps the config scope;
  // reload on any writing/config revision so the list never goes stale.
  let seen = $state(`${ui.revision.writing}:${ui.revision.config}`);
  $effect(() => {
    const now = `${ui.revision.writing}:${ui.revision.config}`;
    if (now === seen) return;
    seen = now;
    void load();
  });

  const reload = () => void load();
</script>

<svelte:window onfocus={reload} />

<aside class="sidebar writing-sidebar">
  <div class="pane-head">
    <span class="pane-title">{$t("writing.title")}</span>
    <span class="muted">
      {$t("writing.sidebarCoverage", {
        values: { mapped: coverage.mapped, total: coverage.total },
      })}
    </span>
  </div>

  <label class="sidebar-search">
    <Search size={13} />
    <input placeholder={$t("writing.sidebarSearch")} bind:value={filter} />
  </label>

  {#if error}<p class="error">{error}</p>{/if}

  {#if glyphs.length === 0}
    <p class="muted">{$t("writing.sidebarEmpty")}</p>
  {/if}

  {#each groups as group (group.name)}
    <div class="section-title">{group.name} <span class="muted">{group.glyphs.length}</span></div>
    {#each group.glyphs as glyph (glyph.id)}
      <button class="sidebar-glyph" onclick={() => openGlyph(glyph.id, glyph)}>
        <span>{glyph.name}</span>
        <span class="muted mono">U+{glyph.codepoint.toString(16).toUpperCase()}</span>
      </button>
    {/each}
  {/each}
</aside>
