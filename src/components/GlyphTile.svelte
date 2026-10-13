<!-- One glyph tile in the writing-system grid. -->
<script lang="ts">
  import type { GlyphMeta } from "../lib/api";

  interface Props {
    glyph: GlyphMeta;
    symbols: string[];
    selected: boolean;
    onSelect: () => void;
    onMenu: (event: MouseEvent) => void;
  }

  let { glyph, symbols, selected, onSelect, onMenu }: Props = $props();
</script>

<button
  class="glyph-tile"
  class:selected
  onclick={onSelect}
  oncontextmenu={(e) => {
    e.preventDefault();
    onMenu(e);
  }}
>
  <span class="glyph-name">{glyph.name}</span>
  {#if symbols.length}
    <span class="glyph-symbols">{symbols.join(" ")}</span>
  {/if}
</button>
