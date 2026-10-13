<!-- Wrapping grid of glyph tiles for the selected group. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta, Phoneme } from "../lib/api";
  import GlyphTile from "./GlyphTile.svelte";

  interface Props {
    glyphs: GlyphMeta[];
    phonemes: Phoneme[];
    selectedId: string | null;
    onSelect: (glyph: GlyphMeta) => void;
    onMenu: (event: MouseEvent, glyph: GlyphMeta) => void;
  }

  let { glyphs, phonemes, selectedId, onSelect, onMenu }: Props = $props();

  const byId = $derived(new Map(phonemes.map((p) => [p.id ?? p.symbol, p.symbol])));

  function symbolsOf(glyph: GlyphMeta): string[] {
    return glyph.phonemes.map((id) => byId.get(id) ?? id);
  }
</script>

{#if glyphs.length === 0}
  <p class="muted">{$t("writing.noGlyphs")}</p>
{:else}
  <div class="glyph-grid">
    {#each glyphs as glyph (glyph.id)}
      <GlyphTile
        {glyph}
        symbols={symbolsOf(glyph)}
        selected={glyph.id === selectedId}
        onSelect={() => onSelect(glyph)}
        onMenu={(e) => onMenu(e, glyph)}
      />
    {/each}
  </div>
{/if}
