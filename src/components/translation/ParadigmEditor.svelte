<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import type {
    AffixKind,
    Morphology,
    MorphemeRef,
    Paradigm,
    ParadigmRow,
  } from "../../lib/api";
  import { morphology as store } from "../../lib/morphology.svelte";

  interface Props {
    morphology: Morphology;
    classId: string;
    onChange: (morphology: Morphology) => void;
  }

  let { morphology, classId, onChange }: Props = $props();

  const KINDS: AffixKind[] = ["prefix", "infix", "suffix"];

  let creating = $state<number | null>(null);
  let newTable = $state("");
  let newSurface = $state("");
  let newGloss = $state("");

  function paradigmFor(id: string): Paradigm {
    return (
      morphology.paradigms.find((paradigm) => paradigm.class === id) ?? {
        class: id,
        rows: [],
      }
    );
  }

  const paradigm = $derived(paradigmFor(classId));
  const slotNames = $derived([
    ...new Set(
      paradigm.rows.map((row) => row.slot).filter((slot): slot is string => !!slot),
    ),
  ]);

  function update(next: Paradigm) {
    const others = morphology.paradigms.filter((p) => p.class !== next.class);
    onChange({ ...morphology, paradigms: [...others, next] });
  }

  function nextOrder(): number {
    return paradigm.rows.reduce((max, row) => Math.max(max, row.order ?? 0), 0) + 1;
  }

  function addRow() {
    const row: ParadigmRow = {
      when: {},
      surface: "",
      kind: "suffix",
      slot: null,
      order: nextOrder(),
      morpheme: null,
      zero: false,
    };
    update({ ...paradigm, rows: [...paradigm.rows, row] });
  }

  function removeRow(index: number) {
    update({ ...paradigm, rows: paradigm.rows.filter((_, i) => i !== index) });
  }

  function patchRow(index: number, patch: Partial<ParadigmRow>) {
    const rows = paradigm.rows.map((row, i) =>
      i === index ? { ...row, ...patch } : row,
    );
    update({ ...paradigm, rows });
  }

  function setWhen(index: number, featureId: string, valueId: string) {
    const row = paradigm.rows[index];
    const when = { ...row.when };
    if (valueId) when[featureId] = valueId;
    else delete when[featureId];
    patchRow(index, { when });
  }

  /** What the row's surface control is currently editing. */
  function mode(row: ParadigmRow): "zero" | "ref" | "broken" | "free" {
    if (row.zero) return "zero";
    if (row.morpheme) {
      return store.resolveMorpheme(row.morpheme) ? "ref" : "broken";
    }
    return "free";
  }

  /** The morpheme `<select>` value encoding the row's current source. */
  function selectValue(row: ParadigmRow): string {
    if (row.zero) return "__zero";
    if (row.morpheme) {
      const resolved = store.resolveMorpheme(row.morpheme);
      return resolved ? `ref:${resolved.table}:${resolved.id}` : "__broken";
    }
    return "__free";
  }

  function onSelect(index: number, value: string) {
    if (value === "__free") {
      patchRow(index, { morpheme: null, zero: false });
    } else if (value === "__zero") {
      patchRow(index, { morpheme: null, zero: true });
    } else if (value.startsWith("ref:")) {
      const [, table, id] = value.split(":");
      patchRow(index, { morpheme: { table, id } as MorphemeRef, zero: false });
    }
  }

  function startCreate(index: number) {
    creating = index;
    newTable = store.fixesTables()[0] ?? "";
    newSurface = "";
    newGloss = "";
  }

  async function createFor(index: number) {
    if (!newTable || !newSurface.trim()) return;
    const morpheme = await store.createMorpheme(
      newTable,
      newSurface.trim(),
      newGloss.trim(),
    );
    if (morpheme) {
      patchRow(index, {
        morpheme: { table: morpheme.table, id: morpheme.id },
        zero: false,
      });
    }
    creating = null;
    newSurface = "";
    newGloss = "";
  }
</script>

<div class="paradigm-editor">
  <p class="muted">{$t("morphology.paradigmHint")}</p>

  {#if paradigm.rows.length === 0}
    <p class="muted">{$t("morphology.noEndings")}</p>
  {/if}

  {#each paradigm.rows as row, index (index)}
    {@const rowMode = mode(row)}
    {@const resolved =
      row.morpheme && rowMode === "ref" ? store.resolveMorpheme(row.morpheme) : undefined}
    <div class="paradigm-row">
      <div class="rule-when">
        {#each morphology.features as feature (feature.id)}
          <label class="when">
            <span class="muted">{feature.label}</span>
            <select
              value={row.when[feature.id] ?? ""}
              onchange={(e) => setWhen(index, feature.id, e.currentTarget.value)}
            >
              <option value="">{$t("morphology.any")}</option>
              {#each feature.values as value (value.id)}
                <option value={value.id}>{value.label}</option>
              {/each}
            </select>
          </label>
        {/each}
      </div>

      <div class="rule-form">
        <label class="mini">
          <span class="muted">{$t("morphology.slot")}</span>
          <input
            list="paradigm-slots"
            placeholder={$t("morphology.slotPlaceholder")}
            value={row.slot ?? ""}
            oninput={(e) =>
              patchRow(index, { slot: e.currentTarget.value || null })}
          />
        </label>
        <label class="mini order">
          <span class="muted">{$t("morphology.order")}</span>
          <input
            type="number"
            value={row.order ?? 0}
            oninput={(e) =>
              patchRow(index, { order: Number(e.currentTarget.value) || 0 })}
          />
        </label>

        {#if rowMode === "zero"}
          <span class="badge zero">∅</span>
        {:else if resolved}
          <span class="badge">{$t(`morphology.${resolved.kind}`)}</span>
        {:else}
          <select
            value={row.kind}
            onchange={(e) =>
              patchRow(index, { kind: e.currentTarget.value as AffixKind })}
          >
            {#each KINDS as kind (kind)}
              <option value={kind}>{$t(`morphology.${kind}`)}</option>
            {/each}
          </select>
        {/if}

        <select
          class="morpheme-select"
          class:missing={rowMode === "broken"}
          value={selectValue(row)}
          onchange={(e) => onSelect(index, e.currentTarget.value)}
        >
          <option value="__free">{$t("morphology.freeText")}</option>
          <option value="__zero">{$t("morphology.zeroEnding")}</option>
          {#if rowMode === "broken"}
            <option value="__broken">⚠ {$t("morphology.missingMorpheme")}</option>
          {/if}
          {#each store.morphemes as morpheme (`${morpheme.table}/${morpheme.id}`)}
            <option value={`ref:${morpheme.table}:${morpheme.id}`}
              >{morpheme.surface} · {morpheme.gloss}</option
            >
          {/each}
        </select>

        <button
          class="new-morpheme-btn"
          title={$t("morphology.newMorpheme")}
          onclick={() => startCreate(index)}><Plus size={12} /></button
        >

        {#if rowMode === "free"}
          <input
            class="surface-input"
            placeholder={$t("morphology.endingPlaceholder")}
            value={row.surface}
            oninput={(e) => patchRow(index, { surface: e.currentTarget.value })}
          />
        {/if}

        <button
          class="slot-remove"
          title={$t("morphology.removeRule")}
          onclick={() => removeRow(index)}
        >
          <X size={13} />
        </button>
      </div>

      {#if creating === index}
        <div class="new-morpheme">
          {#if store.fixesTables().length === 0}
            <span class="muted small">{$t("morphology.noFixesTable")}</span>
          {:else}
            <select bind:value={newTable}>
              {#each store.fixesTables() as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
            <input
              placeholder={$t("morphology.morphemeSurface")}
              bind:value={newSurface}
            />
            <input
              placeholder={$t("morphology.morphemeGloss")}
              bind:value={newGloss}
            />
            <button onclick={() => createFor(index)}
              >{$t("morphology.addMorpheme")}</button
            >
            <button onclick={() => (creating = null)}>{$t("morphology.cancel")}</button>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  <datalist id="paradigm-slots">
    {#each slotNames as slot (slot)}
      <option value={slot}></option>
    {/each}
  </datalist>

  <button onclick={addRow}><Plus size={13} /> {$t("morphology.addRule")}</button>
</div>
