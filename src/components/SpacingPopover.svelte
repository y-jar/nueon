<!-- Spacing popover: LSB, RSB and advance for one glyph, a live test pair, and copy-from. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { GlyphMeta, GlyphOutline } from "../lib/api";
  import { bearingsOf, pairLayout, pairText } from "../lib/writingSpacing";
  import { cellViewBox, previewOf } from "../lib/writingGrid";
  import type { GlyphLookup } from "../lib/writingComponents";

  interface Props {
    glyph: GlyphMeta;
    glyphs: GlyphMeta[];
    outlines: Record<string, GlyphOutline | null | undefined>;
    lookup: GlyphLookup;
    neighbours: string[];
    ascender: number;
    descender: number;
    selectedCount: number;
    onSet: (field: "lsb" | "rsb" | "advance", value: number) => void;
    onCopyFrom: (donorId: string) => void;
    onApplyToSelected: (lsb: number | null, rsb: number | null) => void;
    onClose: () => void;
  }

  let {
    glyph,
    glyphs,
    outlines,
    lookup,
    neighbours,
    ascender,
    descender,
    selectedCount,
    onSet,
    onCopyFrom,
    onApplyToSelected,
    onClose,
  }: Props = $props();

  const empty: GlyphOutline = { elements: [] };
  const outlineOf = (id: string): GlyphOutline => outlines[id] ?? empty;
  const outline = $derived(outlineOf(glyph.id));
  const b = $derived(bearingsOf(outline, lookup));
  const pairs = $derived(pairText(glyph.id, neighbours));
  let donor = $state("");

  function parse(raw: string): number | null {
    if (raw.trim() === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }

  function runShape(ids: string[]) {
    const outs = ids.map((id) => outlineOf(id));
    const lay = pairLayout(outs, lookup);
    const box = cellViewBox(Math.max(lay.total, 1), ascender, descender);
    const paths = outs.map((o, i) => ({ d: previewOf(o, lookup).d, x: lay.offsets[i], id: ids[i] }));
    return { lay, box, paths };
  }

  const lsbBlocked = $derived(b.lsb === null);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="spacing-popover" data-testid="spacing-popover" onkeydown={(e) => e.key === "Escape" && onClose()}>
  <div class="spacing-head">
    <strong>{glyph.name}</strong>
    <span class="grow"></span>
    <button aria-label={$t("writing.spacing.close")} onclick={onClose}>&times;</button>
  </div>
  <div class="spacing-fields">
    {#each [["lsb", b.lsb], ["rsb", b.rsb], ["advance", b.advance]] as [field, value] (field)}
      <label>
        <span>{$t(`writing.metrics.${field}`)}</span>
        <input
          type="number"
          data-spacing-field={field}
          disabled={field !== "advance" && value === null}
          value={value === null ? "" : Math.round(value as number)}
          onchange={(e) => {
            const v = parse(e.currentTarget.value);
            if (v !== null) onSet(field as "lsb" | "rsb" | "advance", v);
          }}
        />
      </label>
    {/each}
  </div>
  {#if lsbBlocked}<p class="muted">{$t("writing.spacing.noInk")}</p>{/if}

  <div class="pair-list" data-testid="pair-list">
    {#each pairs as pair (pair.join('|'))}
      {@const shape = runShape(pair)}
      <figure class="pair">
        <svg
          viewBox="{shape.box.x} {shape.box.y} {shape.box.w} {shape.box.h}"
          width="110"
          height="64"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        >
          {#each shape.paths as p, i (i)}
            <rect
              class="pair-box"
              x={shape.lay.offsets[i]}
              y={shape.box.y}
              width={bearingsOf(outlineOf(pair[i]), lookup).advance}
              height={shape.box.h}
            />
            <path class="pair-ink" d={p.d} transform="translate({p.x} 0)" />
          {/each}
        </svg>
        <figcaption class="mono" data-pair={pair.join("|")}>
          {shape.lay.gaps.map((g) => (g === null ? "-" : Math.round(g))).join(" ")}
        </figcaption>
      </figure>
    {/each}
  </div>

  <div class="spacing-actions">
    <label>
      <span>{$t("writing.spacing.copyFrom")}</span>
      <select bind:value={donor} data-testid="copy-from">
        <option value="">{$t("writing.spacing.pick")}</option>
        {#each glyphs.filter((g) => g.id !== glyph.id) as g (g.id)}
          <option value={g.id}>{g.name}</option>
        {/each}
      </select>
    </label>
    <button data-testid="copy-spacing" disabled={!donor} onclick={() => onCopyFrom(donor)}>
      {$t("writing.spacing.copy")}
    </button>
    <button
      data-testid="apply-to-selected"
      disabled={selectedCount === 0 || lsbBlocked}
      onclick={() => onApplyToSelected(b.lsb, b.rsb)}
    >
      {$t("writing.spacing.applyTo", { values: { count: selectedCount } })}
    </button>
  </div>
</div>
