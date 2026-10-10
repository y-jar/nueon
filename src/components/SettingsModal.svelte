<!-- Settings modal shell with Escape handling. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { X } from "@lucide/svelte";
  import { ui, closeSettings } from "../lib/state.svelte";
  import Settings from "./Settings.svelte";

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && ui.settingsOpen) closeSettings();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if ui.settingsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="modal-overlay"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) closeSettings();
    }}
  >
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <span class="pane-title">{$t("activity.settings")}</span>
        <button title={$t("tabs.close")} onclick={closeSettings}>
          <X size={16} />
        </button>
      </div>
      <div class="modal-body">
        <Settings />
      </div>
    </div>
  </div>
{/if}
