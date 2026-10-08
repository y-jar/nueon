<script lang="ts">
  import type { Feature, FeatureSelections } from "../../lib/api";

  interface Props {
    features: Feature[];
    selections: FeatureSelections;
    onToggle: (featureId: string, valueId: string) => void;
  }

  let { features, selections, onToggle }: Props = $props();
</script>

{#if features.length}
  <div class="feature-bar" role="group">
    {#each features as feature (feature.id)}
      <div class="feature-group">
        <span class="feature-label">{feature.label}</span>
        <div class="feature-values">
          {#each feature.values as value (value.id)}
            <button
              class:active={selections[feature.id] === value.id}
              onclick={() => onToggle(feature.id, value.id)}>{value.label}</button
            >
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}
