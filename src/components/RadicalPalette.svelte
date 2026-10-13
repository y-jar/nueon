<!-- Radical palette: reusable components to insert into the active glyph. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta } from "../lib/api";
  import { insertComponent } from "../lib/writingEditor.svelte";

  interface Props {
    glyphs: GlyphMeta[];
  }

  let { glyphs }: Props = $props();
</script>

<div class="radical-palette">
  <h2>{$t("writing.components")}</h2>
  {#if glyphs.length === 0}
    <p class="muted">{$t("writing.noComponents")}</p>
  {:else}
    {#each glyphs as glyph (glyph.id)}
      <button
        class="radical"
        title={$t("writing.insertComponent", { values: { name: glyph.name } })}
        onclick={() => insertComponent(glyph.id)}
      >
        {glyph.name}
      </button>
    {/each}
  {/if}
</div>
