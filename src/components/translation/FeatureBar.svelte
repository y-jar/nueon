<!-- Feature selection bar for paradigms. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import type { Feature, FeatureSelections } from "../../lib/api";

  interface Props {
    features: Feature[];
    selections: FeatureSelections;
    onToggle: (featureId: string, valueId: string) => void;
    /** Optional: values with no defined ending (styled; click routes to onMissing). */
    missing?: (featureId: string, valueId: string) => boolean;
    onMissing?: (featureId: string, valueId: string) => void;
  }

  let { features, selections, onToggle, missing, onMissing }: Props = $props();
</script>

{#if features.length}
  <div class="feature-bar" role="group">
    {#each features as feature (feature.id)}
      <div class="feature-group">
        <span class="feature-label">{feature.label}</span>
        <div class="feature-values">
          {#each feature.values as value (value.id)}
            {@const isMissing = missing?.(feature.id, value.id) ?? false}
            <button
              class:active={selections[feature.id] === value.id}
              class:missing={isMissing}
              title={isMissing ? $t("morphology.noEnding") : undefined}
              onclick={() =>
                isMissing
                  ? onMissing?.(feature.id, value.id)
                  : onToggle(feature.id, value.id)}>{value.label}</button
            >
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}
