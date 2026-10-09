<script lang="ts">
  interface Props {
    /** The input the list hangs below. */
    anchor: HTMLElement | null;
    items: string[];
    highlight: number;
    onPick: (value: string) => void;
  }

  let { anchor, items, highlight, onPick }: Props = $props();

  let pos = $state({ top: 0, left: 0, width: 0 });

  function place() {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    pos = { top: rect.bottom + 2, left: rect.left, width: rect.width };
  }

  // Portal to <body>: the grid clips table cells (`overflow: hidden`), so a
  // dropdown rendered inside the cell would be cut off.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  $effect(() => {
    // Re-anchor when the input or the item set changes.
    void items;
    place();
  });

  $effect(() => {
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  });
</script>

<ul
  class="suggestions"
  role="listbox"
  use:portal
  style:top="{pos.top}px"
  style:left="{pos.left}px"
  style:min-width="{pos.width}px"
>
  {#each items as item, index (item)}
    <li>
      <button
        type="button"
        class:active={index === highlight}
        onmousedown={(event) => {
          // Keep focus in the input so its blur handler never fires first.
          event.preventDefault();
          onPick(item);
        }}>{item}</button
      >
    </li>
  {/each}
</ul>
