<!-- Glyph metrics: active phonemes, side bearings and advance width. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta, Phoneme } from "../lib/api";
  import { currentSpacing, editor, selectedKind, setSpacingField, setSelectedKind } from "../lib/writingEditor.svelte";
  import type { NodeKind } from "../lib/api";
  import { FORM_KEYS, formChoices, setForm, type FormKey } from "../lib/writingForms";

  interface Props {
    phonemes: Phoneme[];
    glyphs: GlyphMeta[];
    onGlyphChange: (glyph: GlyphMeta) => void;
  }

  let { phonemes, glyphs, onGlyphChange }: Props = $props();

  const KINDS: NodeKind[] = ["corner", "smooth", "symmetric"];
  const kind = $derived(editor.selection.length > 0 ? selectedKind() : null);

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

  const spacing = $derived((editor.outline, currentSpacing()));

  /** Whole font units: fractional ink positions are not meaningful in an exported font. */
  function shown(v: number | null): number | string {
    return v === null ? "" : Math.round(v);
  }

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

  <div class="metric-block node-type" data-testid="node-type">
    <span class="metric-label">{$t("writing.nodeType.title")}</span>
    {#if editor.selection.length === 0}
      <p class="muted">{$t("writing.nodeType.none")}</p>
    {:else}
      <div class="node-type-buttons" role="group" aria-label={$t("writing.nodeType.title")}>
        {#each KINDS as k (k)}
          <button
            class:active={kind === k}
            aria-pressed={kind === k}
            data-kind={k}
            title={`${$t(`writing.nodeType.${k}`)} — ${$t("writing.nodeType.hint")}`}
            onclick={() => setSelectedKind(k)}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              {#if k === "corner"}
                <rect x="2" y="2" width="8" height="8" />
              {:else if k === "smooth"}
                <circle cx="6" cy="6" r="4" />
              {:else}
                <circle cx="6" cy="6" r="4" /><line x1="1" y1="6" x2="11" y2="6" />
              {/if}
            </svg>
            {$t(`writing.nodeType.${k}`)}
          </button>
        {/each}
      </div>
      {#if kind === null}<p class="muted">{$t("writing.nodeType.mixed")}</p>{/if}
    {/if}
  </div>

  {#each [["lsb", "lsb"], ["rsb", "rsb"], ["advance", "advance"]] as [field, label] (field)}
    <div class="metric-block">
      <span class="metric-label">{$t(`writing.metrics.${label}`)}</span>
      <input
        type="number"
        title={$t("writing.metricsHint")}
        data-spacing={field}
        disabled={field !== "advance" && spacing?.[field as "lsb" | "rsb"] === null}
        value={spacing ? shown(spacing[field as keyof typeof spacing]) : ""}
        onchange={(e) => setSpacingField(field as "lsb" | "rsb" | "advance", parseMetric(e.currentTarget.value))}
      />
    </div>
  {/each}

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
