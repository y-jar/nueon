<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import type {
    AffixKind,
    Morphology,
    MorphemeInfo,
    Paradigm,
    ParadigmRow,
  } from "../../lib/api";

  interface Props {
    morphology: Morphology;
    classId: string;
    morphemes: MorphemeInfo[];
    onChange: (morphology: Morphology) => void;
  }

  let { morphology, classId, morphemes, onChange }: Props = $props();

  const KINDS: AffixKind[] = ["prefix", "infix", "suffix"];

  function paradigmFor(classId: string): Paradigm {
    return (
      morphology.paradigms.find((paradigm) => paradigm.class === classId) ?? {
        class: classId,
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

  /** The fixes-table morpheme a row references, if it resolves. */
  function morphemeFor(reference: string | null | undefined): MorphemeInfo | undefined {
    if (!reference) return undefined;
    return morphemes.find(
      (morpheme) =>
        morpheme.wordname === reference || morpheme.triggers.includes(reference),
    );
  }
</script>

<div class="paradigm-editor">
  <p class="muted">{$t("morphology.paradigmHint")}</p>

  {#if paradigm.rows.length === 0}
    <p class="muted">{$t("morphology.noEndings")}</p>
  {/if}

  {#each paradigm.rows as row, index (index)}
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
        <select
          value={row.kind}
          onchange={(e) =>
            patchRow(index, { kind: e.currentTarget.value as AffixKind })}
        >
          {#each KINDS as kind (kind)}
            <option value={kind}>{$t(`morphology.${kind}`)}</option>
          {/each}
        </select>
        <select
          value={row.morpheme ?? ""}
          onchange={(e) =>
            patchRow(index, { morpheme: e.currentTarget.value || null })}
        >
          <option value="">{$t("morphology.inline")}</option>
          {#each morphemes as morpheme (`${morpheme.table}/${morpheme.wordname}`)}
            <option value={morpheme.wordname}
              >{morpheme.wordname} · {morpheme.gloss}</option
            >
          {/each}
        </select>

        {#if row.morpheme}
          {@const morpheme = morphemeFor(row.morpheme)}
          <span class="surface-preview mono" class:missing={!morpheme}>
            {morpheme ? morpheme.surface : $t("morphology.unknownMorpheme")}
          </span>
        {:else}
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
    </div>
  {/each}

  <datalist id="paradigm-slots">
    {#each slotNames as slot (slot)}
      <option value={slot}></option>
    {/each}
  </datalist>

  <button onclick={addRow}><Plus size={13} /> {$t("morphology.addRule")}</button>
</div>
