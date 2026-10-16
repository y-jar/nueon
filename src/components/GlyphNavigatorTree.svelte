<!-- Glyph groups and sound coverage for the writing system. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import type { GlyphMeta, Phoneme } from "../lib/api";

  interface Props {
    groups: Map<string, GlyphMeta[]>;
    phonemes: Phoneme[];
    coveredIds: Set<string>;
    selectedGroup: string | null;
    onSelectGroup: (group: string | null) => void;
    onAddFor: (phoneme: Phoneme) => void;
  }

  let {
    groups,
    phonemes,
    coveredIds,
    selectedGroup,
    onSelectGroup,
    onAddFor,
  }: Props = $props();
</script>

<div class="writing-nav">
  <button
    class="nav-row"
    class:active={selectedGroup === null}
    title={$t("writing.allGlyphsHint")}
    onclick={() => onSelectGroup(null)}
  >
    <span>{$t("writing.all")}</span>
  </button>

  <h2>{$t("writing.glyphs")}</h2>
  {#each [...groups.keys()] as group (group)}
    <button
      class="nav-row"
      class:active={selectedGroup === group}
      title={$t("writing.groupHint", { values: { group } })}
      onclick={() => onSelectGroup(group)}
    >
      <span>{group}</span>
      <span class="muted">{groups.get(group)!.length}</span>
    </button>
  {/each}

  <h2>{$t("writing.groups")}</h2>
  {#each phonemes as phoneme (phoneme.id ?? phoneme.symbol)}
    <div class="sound-row">
      <span class="symbol" class:muted={!coveredIds.has(phoneme.id ?? phoneme.symbol)}
        >{phoneme.symbol}</span
      >
      {#if coveredIds.has(phoneme.id ?? phoneme.symbol)}
        <span class="muted">&#10003;</span>
      {:else}
        <button title={$t("writing.addGlyph")} onclick={() => onAddFor(phoneme)}>
          <Plus size={11} />
        </button>
      {/if}
    </div>
  {/each}
</div>
