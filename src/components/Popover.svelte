<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Content of the trigger button. */
    label: Snippet;
    /** Which trigger edge the panel aligns to. */
    align?: "left" | "right";
    /** Content; receives a function that closes the popover. */
    children: Snippet<[() => void]>;
  }

  let { label, align = "left", children }: Props = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  let pos = $state({ top: 0, left: 0 });

  /** Move the node to <body> so ancestor `overflow: hidden` cannot clip it. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function place() {
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = panel?.offsetWidth ?? 240;
    const preferred = align === "right" ? rect.right - width : rect.left;
    const left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
    pos = { top: rect.bottom + 4, left };
  }

  function toggle() {
    open = !open;
    if (open) place();
  }

  // Reposition once the panel has been measured.
  $effect(() => {
    if (open && panel) place();
  });

  // Global dismissal: click outside, Escape, or a layout change.
  $effect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel?.contains(target) || trigger?.contains(target)) return;
      open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        open = false;
        trigger?.focus();
      }
    };
    const onLayout = () => (open = false);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onLayout);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLayout);
    };
  });
</script>

<button
  bind:this={trigger}
  type="button"
  class="popover-trigger"
  class:active={open}
  aria-expanded={open}
  onclick={toggle}
>
  {@render label()}
</button>

{#if open}
  <div
    use:portal
    bind:this={panel}
    class="popover-panel"
    style:top="{pos.top}px"
    style:left="{pos.left}px"
  >
    {@render children(() => (open = false))}
  </div>
{/if}
