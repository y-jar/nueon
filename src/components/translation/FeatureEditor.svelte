<script lang="ts">
  import { t } from "svelte-i18n";
  import { Plus, X } from "@lucide/svelte";
  import type { Feature, FeatureValue, Morphology } from "../../lib/api";

  interface Props {
    morphology: Morphology;
    onChange: (morphology: Morphology) => void;
  }

  let { morphology, onChange }: Props = $props();

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
      features: [...morphology.features, { id, label: id, values: [] }],
    });
  }

  function removeFeature(index: number) {
    onChange({
      ...morphology,
      features: morphology.features.filter((_, i) => i !== index),
    });
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
        <button
          class="slot-remove"
          title={$t("morphology.removeFeature")}
          onclick={() => removeFeature(index)}
        >
          <X size={13} />
        </button>
      </div>
      <div class="feature-values">
        {#each feature.values as value, valueIndex (value.id)}
          <span class="value-chip">
            <input
              value={value.label}
              oninput={(e) => setValue(index, valueIndex, e.currentTarget.value)}
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
      </div>
    </div>
  {/each}

  <button onclick={addFeature}><Plus size={13} /> {$t("morphology.addFeature")}</button>
</div>
