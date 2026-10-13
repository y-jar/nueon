<!-- Bottom tray of glyph thumbnails. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus } from "@lucide/svelte";
  import type { GlyphMeta } from "../lib/api";

  interface Props {
    glyphs: GlyphMeta[];
    currentId: string | null;
    onOpen: (glyph: GlyphMeta) => void;
    onAdd: () => void;
  }

  let { glyphs, currentId, onOpen, onAdd }: Props = $props();
</script>

<div class="glyph-tray">
  {#each glyphs as glyph (glyph.id)}
    <button
      class="tray-tile"
      class:active={glyph.id === currentId}
      title={glyph.name}
      onclick={() => onOpen(glyph)}
    >
      {glyph.name}
    </button>
  {/each}
  <button class="tray-tile tray-add" title={$t("writing.addGlyph")} onclick={onAdd}>
    <Plus size={14} />
  </button>
</div>
