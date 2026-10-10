<!-- Feature and paradigm editor. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import * as api from "../../lib/api";
  import { ui } from "../../lib/state.svelte";
  import type { Feature, FeatureValue, Morphology } from "../../lib/api";

  interface Props {
    morphology: Morphology;
    onChange: (morphology: Morphology) => void;
  }

  let { morphology, onChange }: Props = $props();

  /** Distinct values read from a bound column, cached by table+column. */
  let derived = $state<Record<string, string[]>>({});

  $effect(() => {
    for (const feature of morphology.features) {
      const column = feature.column;
      if (!column) continue;
      const key = `${column.table}\u0000${column.column}`;
      if (key in derived) continue;
      void api
        .featureValues(column.table, column.column)
        .then((values) => {
          derived = { ...derived, [key]: values };
        })
        .catch(() => {});
    }
  });

  function uniqueId(prefix: string, taken: string[]): string {
    let n = taken.length + 1;
    let id = `${prefix}-${n}`;
    while (taken.includes(id)) id = `${prefix}-${++n}`;
    return id;
  }

  function setFeature(index: number, patch: Partial<Feature>) {
    const features = morphology.features.map((feature, i) =>
      i === index ? { ...feature, ...patch } : feature,
    );
    onChange({ ...morphology, features });
  }

  function addFeature() {
    const id = uniqueId(
      "feature",
      morphology.features.map((feature) => feature.id),
    );
    onChange({
      ...morphology,
      features: [...morphology.features, { id, label: id, values: [], column: null }],
    });
  }

  function removeFeature(index: number) {
    onChange({
      ...morphology,
      features: morphology.features.filter((_, i) => i !== index),
    });
  }

  function textColumns(table: string): string[] {
    const found = ui.tables.find((entry) => entry.name === table);
    return (found?.tags ?? [])
      .filter((tag) => tag.kind === "text" || tag.kind === "tag_list")
      .map((tag) => tag.name);
  }

  function setBinding(index: number, table: string) {
    if (!table) {
      setFeature(index, { column: null });
      return;
    }
    const columns = textColumns(table);
    setFeature(index, { column: { table, column: columns[0] ?? "" } });
  }

  function setBindingColumn(index: number, column: string) {
    const feature = morphology.features[index];
    if (feature.column) {
      setFeature(index, { column: { table: feature.column.table, column } });
    }
  }

  function setValue(featureIndex: number, valueIndex: number, label: string) {
    const feature = morphology.features[featureIndex];
    const values = feature.values.map((value, i) =>
      i === valueIndex ? { ...value, label } : value,
    );
    setFeature(featureIndex, { values });
  }

  function addValue(featureIndex: number) {
    const feature = morphology.features[featureIndex];
    const id = uniqueId(
      feature.id,
      feature.values.map((value) => value.id),
    );
    const value: FeatureValue = { id, label: id };
    setFeature(featureIndex, { values: [...feature.values, value] });
  }

  function removeValue(featureIndex: number, valueIndex: number) {
    const feature = morphology.features[featureIndex];
    setFeature(featureIndex, {
      values: feature.values.filter((_, i) => i !== valueIndex),
    });
  }
</script>

<div class="feature-editor">
  {#if morphology.features.length === 0}
    <p class="muted">{$t("morphology.noFeatures")}</p>
  {/if}

  {#each morphology.features as feature, index (feature.id)}
    <div class="feature-block">
      <div class="feature-head">
        <input
          class="feature-label"
          value={feature.label}
          oninput={(e) => setFeature(index, { label: e.currentTarget.value })}
        />
        <label class="bind">
          <span class="muted">{$t("morphology.inherent")}</span>
          <select
            value={feature.column?.table ?? ""}
            onchange={(e) => setBinding(index, e.currentTarget.value)}
          >
            <option value="">{$t("morphology.inflectional")}</option>
            {#each ui.tables as table (table.name)}
              <option value={table.name}>{table.name}</option>
            {/each}
          </select>
        </label>
        {#if feature.column}
          <select
            value={feature.column.column}
            onchange={(e) => setBindingColumn(index, e.currentTarget.value)}
          >
            {#each textColumns(feature.column.table) as column (column)}
              <option value={column}>{column}</option>
            {/each}
          </select>
        {/if}
        <button
          class="slot-remove"
          title={$t("morphology.removeFeature")}
          onclick={() => removeFeature(index)}
        >
          <X size={13} />
        </button>
      </div>

      <div class="feature-values">
        {#if feature.column}
          {@const key = `${feature.column.table}\u0000${feature.column.column}`}
          <span class="value-chip read-only">{$t("morphology.unset")}</span>
          {#each derived[key] ?? [] as value (value)}
            <span class="value-chip read-only">{value}</span>
          {/each}
        {:else}
          {#each feature.values as value, valueIndex (value.id)}
            <span class="value-chip">
              <input
                value={value.label}
                oninput={(e) =>
                  setValue(index, valueIndex, e.currentTarget.value)}
              />
              <button
                title={$t("morphology.removeValue")}
                onclick={() => removeValue(index, valueIndex)}
              >
                <X size={11} />
              </button>
            </span>
          {/each}
          <button class="add-value" onclick={() => addValue(index)}>
            <Plus size={12} /> {$t("morphology.addValue")}
          </button>
        {/if}
      </div>
    </div>
  {/each}

  <button onclick={addFeature}><Plus size={13} /> {$t("morphology.addFeature")}</button>
</div>
