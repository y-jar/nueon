<script lang="ts">
  import { X } from "@lucide/svelte";
  import { ui, dismissToast } from "../lib/state.svelte";
</script>

{#if ui.toast}
  <div class="toast" role="status" aria-live="polite">
    <span class="toast-message">{ui.toast.message}</span>
    {#if ui.toast.actionLabel && ui.toast.onAction}
      <button
        class="toast-action"
        onclick={() => {
          const run = ui.toast?.onAction;
          dismissToast();
          run?.();
        }}
      >
        {ui.toast.actionLabel}
      </button>
    {/if}
    <button class="toast-close" aria-label="Dismiss" onclick={dismissToast}>
      <X size={13} />
    </button>
  </div>
{/if}
