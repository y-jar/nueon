<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    ui,
    closeContextMenu,
    requestNew,
    requestRename,
    deletePath,
    selectNote,
  } from "../lib/state.svelte";

  let menuEl: HTMLElement | undefined;

  // Portal the menu to <body> so it is never clipped by pane overflow.
  function portal(node: HTMLElement) {
    menuEl = node;
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
        menuEl = undefined;
      },
    };
  }

  const base = $derived(
    ui.contextMenu
      ? ui.contextMenu.isDir
        ? ui.contextMenu.path
        : ui.contextMenu.path.split("/").slice(0, -1).join("/")
      : "",
  );

  $effect(() => {
    if (!ui.contextMenu) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    const onScroll = () => closeContextMenu();
    const onPointerDown = (event: MouseEvent) => {
      if (menuEl && !menuEl.contains(event.target as Node)) {
        closeContextMenu();
      }
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("mousedown", onPointerDown, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("mousedown", onPointerDown, true);
    };
  });
</script>

{#if ui.contextMenu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    use:portal
    style="left: {ui.contextMenu.x}px; top: {ui.contextMenu.y}px"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if ui.contextMenu.path !== ""}
      {#if !ui.contextMenu.isDir}
        <button
          onclick={() => {
            selectNote(ui.contextMenu!.path);
            closeContextMenu();
          }}>{$t("contextMenu.open")}</button
        >
      {/if}
      <button onclick={() => requestNew("note", base)}
        >{$t("contextMenu.newNote")}</button
      >
      <button onclick={() => requestNew("folder", base)}
        >{$t("contextMenu.newFolder")}</button
      >
      <button onclick={() => requestRename(ui.contextMenu!.path)}
        >{$t("contextMenu.rename")}</button
      >
      <button
        onclick={() => {
          deletePath(ui.contextMenu!.path);
          closeContextMenu();
        }}>{$t("contextMenu.delete")}</button
      >
    {:else}
      <button onclick={() => requestNew("note", "")}
        >{$t("contextMenu.newNote")}</button
      >
      <button onclick={() => requestNew("folder", "")}
        >{$t("contextMenu.newFolder")}</button
      >
    {/if}
  </div>
{/if}
