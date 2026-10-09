<script lang="ts">
  import { t } from "svelte-i18n";
  import { ui, suppressConfirm } from "../lib/state.svelte";

  let cancelButton = $state<HTMLButtonElement | null>(null);
  let dontAsk = $state(false);

  // Cancel is the default focus so a stray Enter never confirms a delete.
  $effect(() => {
    if (ui.confirm) {
      cancelButton?.focus();
      dontAsk = false;
    }
  });

  function onKey(event: KeyboardEvent) {
    if (ui.confirm && event.key === "Escape") {
      event.stopPropagation();
      ui.confirm.resolve(false);
    }
  }

  function confirm() {
    const request = ui.confirm;
    if (!request) return;
    if (dontAsk && request.kind) void suppressConfirm(request.kind);
    request.resolve(true);
  }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.confirm}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) ui.confirm?.resolve(false);
    }}
  >
    <div
      class="modal confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
    >
      <div class="modal-head">
        <span id="confirm-title" class="pane-title">{ui.confirm.title}</span>
      </div>
      <div class="confirm-body">
        <p id="confirm-message">{ui.confirm.message}</p>
        {#if ui.confirm.kind}
          <label class="confirm-dont-ask">
            <input type="checkbox" bind:checked={dontAsk} />
            {$t("confirm.dontAskAgain")}
          </label>
        {/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button
          class="confirm-cancel"
          bind:this={cancelButton}
          onclick={() => ui.confirm?.resolve(false)}
        >
          {ui.confirm.cancelLabel}
        </button>
        <button
          class="confirm-ok"
          class:danger={ui.confirm.danger}
          onclick={confirm}
        >
          {ui.confirm.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
