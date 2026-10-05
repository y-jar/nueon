<script lang="ts">
  import { t } from "svelte-i18n";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import {
    ui,
    closeContextMenu,
    requestNew,
    requestRename,
    deletePath,
    selectNote,
    refreshTree,
    collapseAll,
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

  const menu = $derived(ui.contextMenu);

  const base = $derived(
    menu
      ? menu.isDir
        ? menu.path
        : menu.path.split("/").slice(0, -1).join("/")
      : "",
  );

  function reveal() {
    if (!menu || !ui.root) return;
    const target = menu.path
      ? `${ui.root}/notes/${menu.path}`
      : `${ui.root}/notes`;
    revealItemInDir(target).catch(() => {});
    closeContextMenu();
  }

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

{#if menu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    use:portal
    style="left: {menu.x}px; top: {menu.y}px"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if menu.kind === "root"}
      <button onclick={() => requestNew("note", "")}
        >{$t("contextMenu.newNote")}</button
      >
      <button onclick={() => requestNew("folder", "")}
        >{$t("contextMenu.newFolder")}</button
      >
      <button
        onclick={() => {
          refreshTree();
          closeContextMenu();
        }}>{$t("contextMenu.refresh")}</button
      >
      <button
        onclick={() => {
          collapseAll();
          closeContextMenu();
        }}>{$t("contextMenu.collapseAll")}</button
      >
      <button onclick={reveal}>{$t("contextMenu.reveal")}</button>
    {:else}
      {#if !menu.isDir}
        <button
          onclick={() => {
            selectNote(menu.path);
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
      <button onclick={() => requestRename(menu.path)}
        >{$t("contextMenu.rename")}</button
      >
      <button
        onclick={() => {
          deletePath(menu.path);
          closeContextMenu();
        }}>{$t("contextMenu.delete")}</button
      >
      <button onclick={reveal}>{$t("contextMenu.reveal")}</button>
    {/if}
  </div>
{/if}
