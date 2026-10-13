<!-- CJK-style composition matrix: combine two radicals per cell. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta } from "../lib/api";

  interface Props {
    glyphs: GlyphMeta[];
    onCompose: (row: GlyphMeta, col: GlyphMeta) => void;
  }

  let { glyphs, onCompose }: Props = $props();
</script>

<div class="composition-matrix">
  <h2>{$t("writing.compose")}</h2>
  <p class="muted">{$t("writing.composeHint")}</p>
  {#if glyphs.length === 0}
    <p class="muted">{$t("writing.noComponents")}</p>
  {:else}
    <div class="matrix-scroll">
      <table class="matrix">
        <thead>
          <tr>
            <th></th>
            {#each glyphs as col (col.id)}
              <th>{col.name}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each glyphs as row (row.id)}
            <tr>
              <th>{row.name}</th>
              {#each glyphs as col (col.id)}
                <td>
                  <button title={`${row.name} + ${col.name}`} onclick={() => onCompose(row, col)}>
                    +
                  </button>
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
