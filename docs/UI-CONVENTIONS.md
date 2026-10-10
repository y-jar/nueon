# UI conventions

Contracts every overlay and interaction follows, so new UI stays consistent and
accessible. When you add an overlay, make it satisfy these and add a probe that
proves the dismissal path (see `probes/probe.mjs` probes 96–97).

## Overlays must dismiss

Every transient overlay closes on all of:

- **Escape** — a `keydown` listener (window-level capture or `svelte:window`).
- **An outside click** — a `mousedown`/`pointerdown` listener that ignores events
  inside the overlay.
- **An action** — choosing an item both applies it and closes the overlay.
- **Scroll / resize / layout change** — where the anchor can move (menus, popovers).

The context menu (`ContextMenu.svelte`) and `Popover.svelte` are the reference
implementations. `ContextMenu.svelte` additionally takes focus on open, moves
between items with Arrow/Home/End, activates on Enter, and returns focus when it
closes.

Do **not** leave an overlay able to get "stuck". Every overlay must be gated by a
single `ui` boolean or a single `{#if}`, so clearing that state always unmounts it.
Avoid `{@const}` over a nullable value inside a branch that gets destroyed — that
was the column-menu bug; use a script-level `$derived` instead.

## Menus

- One shared `ContextMenu.svelte` renders every menu kind (`root`, `node`,
  `table`, `tab`, `column`, `editor`) from `ui.contextMenu`. Openers live in
  `src/lib/context.svelte.ts` and set the payload; the component maps kind →
  items.
- Menus are portaled to `<body>` (`use:portal`) so pane overflow never clips them.

## Modals

- Rendered from a `ui` flag (`settingsOpen`, `setupWizardOpen`, `trashOpen`,
  `importOpen`, or `confirm`). Escape closes, except `ConfirmDialog`, which only
  cancels (Escape = the "cancel" answer).

## Keybinds

- Editor keybinds are declared in `src/lib/keybindings.ts` and user-overridable.
- Shell-level shortcuts (`Ctrl+P` palette, `Ctrl+W` close tab, `Ctrl+Tab`/
  `Ctrl+PageUp/Down` cycle tabs) live in the window `keydown` handler in
  `App.svelte`.
- Reserved combos (`Mod+C/V/X/A/Z/Y/W/R/Shift+I/Shift+J`) are refused by the
  keybind capture UI.

## Focus & accessibility

- `role`/`aria-*` where it helps: tablist/tab with roving tabindex and
  `aria-selected` (see `TabBar.svelte`); `role="menu"` on the context menu.
- Focus-visible outlines on interactive chrome (`base.css`); the tab close button
  appears on `:focus-within`.

## Status & errors

- `ui.status` is the single status-bar line; `ui.toast` for transient messages
  with an optional action.
- Uncaught errors and unhandled rejections are surfaced in the status bar by
  `App.svelte` — do not swallow errors silently; if an operation is best-effort,
  catch it explicitly (`void x().catch(() => {})`).

## CSS variables

The palette is defined once (earthy dark theme) and referenced by `var(--*)`:
`--bg`, `--panel`, `--faint`, `--border`, `--text`, `--muted`, `--accent`,
`--fg`. Add new colours there, never as raw hex in components.
