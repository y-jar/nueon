<!-- Glyph metrics: active phonemes, side bearings and advance width. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta, Phoneme } from "../lib/api";
  import { editor, setMetric } from "../lib/writingEditor.svelte";
  import { FORM_KEYS, formChoices, setForm, type FormKey } from "../lib/writingForms";

  interface Props {
    phonemes: Phoneme[];
    glyphs: GlyphMeta[];
    onGlyphChange: (glyph: GlyphMeta) => void;
  }

  let { phonemes, glyphs, onGlyphChange }: Props = $props();

  const choices = $derived(formChoices(glyphs, editor.glyphMeta?.id ?? ""));

  function chooseForm(key: FormKey, value: string) {
    if (!editor.glyphMeta) return;
    const next = setForm(editor.glyphMeta, key, value || null);
    editor.glyphMeta = next;
    onGlyphChange(next);
  }

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
        <span class="sound-chip">{symbol}</span>
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

  <div class="metric-block forms" data-testid="glyph-forms">
    <span class="metric-label">{$t("writing.forms.title")}</span>
    <p class="muted">{$t("writing.forms.hint")}</p>
    {#each FORM_KEYS as key (key)}
      <label class="form-row">
        <span>{$t(`writing.forms.${key}`)}</span>
        <select
          value={editor.glyphMeta?.forms?.[key] ?? ""}
          onchange={(e) => chooseForm(key, e.currentTarget.value)}
        >
          <option value="">{$t("writing.forms.none")}</option>
          {#each choices as choice (choice.id)}
            <option value={choice.id}>{choice.name}</option>
          {/each}
        </select>
      </label>
    {/each}
  </div>
</div>
