<!-- Glyph metrics: active phonemes, side bearings and advance width. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { Phoneme } from "../lib/api";
  import { editor, setMetric } from "../lib/writingEditor.svelte";

  interface Props {
    phonemes: Phoneme[];
  }

  let { phonemes }: Props = $props();

  const byId = $derived(new Map(phonemes.map((p) => [p.id ?? p.symbol, p.symbol])));
  const symbols = $derived(
    (editor.glyphMeta?.phonemes ?? []).map((id) => byId.get(id) ?? id),
  );

  function parseMetric(raw: string): number | null {
    if (raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
</script>

<div class="glyph-metrics">
  <h2>{editor.glyphMeta?.name ?? ""}</h2>

  <div class="metric-block">
    <span class="metric-label">{$t("writing.metrics.phonemes")}</span>
    <div class="phoneme-chips">
      {#each symbols as symbol (symbol)}
        <span class="chip">{symbol}</span>
      {:else}
        <span class="muted">{$t("writing.metrics.noPhonemes")}</span>
      {/each}
    </div>
  </div>

  <div class="metric-block">
    <span class="metric-label">{$t("writing.metrics.lsb")}</span>
    <input
      type="number"
      value={editor.outline?.lsb ?? ""}
      oninput={(e) => setMetric("lsb", parseMetric(e.currentTarget.value))}
    />
  </div>

  <div class="metric-block">
    <span class="metric-label">{$t("writing.metrics.rsb")}</span>
    <input
      type="number"
      value={editor.outline?.rsb ?? ""}
      oninput={(e) => setMetric("rsb", parseMetric(e.currentTarget.value))}
    />
  </div>

  <div class="metric-block">
    <span class="metric-label">{$t("writing.metrics.advance")}</span>
    <input
      type="number"
      value={editor.outline?.advance ?? ""}
      oninput={(e) => setMetric("advance", parseMetric(e.currentTarget.value))}
    />
  </div>
</div>
