<!-- Editor menu bar: File/Edit/View/Tools/Metrics/Glyphs/Export dropdowns. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import { readTextFile, writeTextFile } from "../lib/files";
  import type { ToolId } from "../lib/writing";
  import {
    GUIDE_FIELDS,
    MENU_LABELS,
    MENU_ORDER,
    menuItems,
    parseGuide,
    type GuideField,
    type MenuId,
    type MenuItem,
  } from "../lib/writingMenus";
  import type { WritingConfig } from "../lib/api";
  import {
    align,
    cycleSelectedKind,
    deleteSelection,
    distribute,
    editor,
    exportGlyphSvg,
    exportSpriteSvg,
    finishPath,
    importSvg,
    mirror,
    redo,
    reorder,
    rotateSelection,
    scaleSelection,
    selectAll,
    setTool,
    setZoom,
    shearSelection,
    toggleCompose,
    toggleGuides,
    toggleSnap,
    undo,
  } from "../lib/writingEditor.svelte";

  interface Props {
    config: WritingConfig;
    onClose: () => void;
    onNewGlyph: () => void;
    onDuplicateGlyph: () => void;
    onDeleteGlyph: () => void;
    onStepGlyph: (step: 1 | -1) => void;
    onGuideChange: (field: GuideField, value: number) => void;
  }

  let {
    config,
    onClose,
    onNewGlyph,
    onDuplicateGlyph,
    onDeleteGlyph,
    onStepGlyph,
    onGuideChange,
  }: Props = $props();

  let openMenu = $state<MenuId | null>(null);
  let bar = $state<HTMLDivElement | null>(null);

  const menuState = $derived({
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
    hasSelection: editor.selection.length > 0,
    snap: editor.snap,
    guides: editor.showGuides,
    hasGlyph: editor.openGlyphId !== null,
  });

  function toggle(menu: MenuId) {
    openMenu = openMenu === menu ? null : menu;
  }

  $effect(() => {
    if (!openMenu) return;
    const onPointer = (event: PointerEvent) => {
      if (!bar?.contains(event.target as Node)) openMenu = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") openMenu = null;
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  function focusStep(event: KeyboardEvent, delta: number) {
    const panel = (event.currentTarget as HTMLElement).closest(".menu-panel");
    const items = [...(panel?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + delta + items.length) % items.length].focus();
    event.preventDefault();
  }

  function onItemKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown") focusStep(event, 1);
    else if (event.key === "ArrowUp") focusStep(event, -1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const at = MENU_ORDER.indexOf(openMenu as MenuId);
      const next = (at + (event.key === "ArrowRight" ? 1 : -1) + MENU_ORDER.length) % MENU_ORDER.length;
      openMenu = MENU_ORDER[next];
      event.preventDefault();
    }
  }

  async function exportText(text: string | null, name: string, label: string) {
    if (text === null) return;
    const path = await saveDialog({
      defaultPath: name,
      filters: [{ name: label, extensions: ["svg"] }],
    });
    if (!path) return;
    try {
      await writeTextFile(path, text);
      editor.status = `exported ${path}`;
    } catch (e) {
      editor.error = String(e);
    }
  }

  async function importFile() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (typeof path !== "string") return;
    try {
      await importSvg(await readTextFile(path));
    } catch (e) {
      editor.error = String(e);
    }
  }

  function run(item: MenuItem) {
    openMenu = null;
    const id = item.id;
    if (id.startsWith("tool-")) return setTool(id.slice(5) as ToolId);
    if (id.startsWith("align-")) return align(id.slice(6) as Parameters<typeof align>[0]);
    if (id.startsWith("order-")) return reorder(id.slice(6) as Parameters<typeof reorder>[0]);
    switch (id) {
      case "import-svg": return void importFile();
      case "close": return onClose();
      case "undo": return undo();
      case "redo": return redo();
      case "select-all": return selectAll();
      case "delete": return deleteSelection();
      case "mirror-h": return mirror("h");
      case "mirror-v": return mirror("v");
      case "scale-up": return scaleSelection(1.1);
      case "scale-down": return scaleSelection(0.9);
      case "rotate-cw": return rotateSelection(-15);
      case "rotate-ccw": return rotateSelection(15);
      case "shear": return shearSelection(10);
      case "distribute-h": return distribute("h");
      case "distribute-v": return distribute("v");
      case "zoom-in": return setZoom(editor.zoom + 0.25);
      case "zoom-out": return setZoom(editor.zoom - 0.25);
      case "zoom-fit": return setZoom(1);
      case "toggle-snap": return toggleSnap();
      case "toggle-guides": return toggleGuides();
      case "node-kind": return cycleSelectedKind();
      case "finish-path": return finishPath();
      case "glyph-new": return onNewGlyph();
      case "glyph-duplicate": return onDuplicateGlyph();
      case "glyph-delete": return onDeleteGlyph();
      case "glyph-prev": return onStepGlyph(-1);
      case "glyph-next": return onStepGlyph(1);
      case "compose": return toggleCompose();
      case "export-svg":
        return void exportGlyphSvg().then((svg) =>
          exportText(svg, `${editor.glyphMeta?.name ?? "glyph"}.svg`, "SVG"),
        );
      case "export-sprite":
        return void exportSpriteSvg().then((svg) => exportText(svg, "glyphs.svg", "SVG sprite"));
    }
  }

  function onGuideInput(field: GuideField, event: Event) {
    const value = parseGuide((event.currentTarget as HTMLInputElement).value);
    if (value !== null) onGuideChange(field, value);
  }
</script>

<div class="editor-menubar" bind:this={bar} role="menubar" aria-label={$t("writing.menuBar")}>
  {#each MENU_ORDER as menu (menu)}
    <div class="menu-wrap">
      <button
        class="menu-item"
        class:open={openMenu === menu}
        role="menuitem"
        aria-haspopup="true"
        aria-expanded={openMenu === menu}
        onclick={() => toggle(menu)}
        onmouseenter={() => openMenu && (openMenu = menu)}
      >
        {MENU_LABELS[menu]}
      </button>
      {#if openMenu === menu}
        <div class="menu-panel" role="menu" tabindex="-1" onkeydown={onItemKey}>
          {#if menu === "metrics"}
            <div class="metrics-form">
              {#each GUIDE_FIELDS as guide (guide.field)}
                <label>
                  <span>{guide.label}</span>
                  <input
                    type="number"
                    value={config[guide.field]}
                    onchange={(e) => onGuideInput(guide.field, e)}
                  />
                </label>
              {/each}
            </div>
          {:else}
            {#each menuItems(menu, menuState) as item (item.id)}
              {#if item.separator}
                <div class="menu-sep" role="separator"></div>
              {:else}
                <button
                  role="menuitem"
                  disabled={item.disabled}
                  onclick={() => run(item)}
                >
                  <span>{item.label}</span>
                  {#if item.shortcut}<span class="menu-shortcut">{item.shortcut}</span>{/if}
                </button>
              {/if}
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>
