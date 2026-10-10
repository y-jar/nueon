<!-- Banner for unloadable dictionary files. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { TriangleAlert, X } from "@lucide/svelte";
  import { ui, dismissQuarantine } from "../lib/state.svelte";

  const visible = $derived(
    ui.quarantine.filter((w) => !ui.quarantineDismissed.includes(w.file_name)),
  );
</script>

{#if visible.length}
  <div class="quarantine-banner" role="alert">
    <div class="quarantine-head">
      <TriangleAlert size={14} />
      <span class="grow"
        >{$t("quarantine.heading", { values: { count: visible.length } })}</span
      >
    </div>
    {#each visible as warning (warning.file_name)}
      <div class="quarantine-row">
        <span class="quarantine-file">{warning.file_name}</span>
        <span class="muted quarantine-reason">{warning.reason}</span>
        <button
          title={$t("quarantine.dismiss")}
          aria-label={$t("quarantine.dismiss")}
          onclick={() => dismissQuarantine(warning.file_name)}
        >
          <X size={13} />
        </button>
      </div>
    {/each}
  </div>
{/if}
