<!-- Modal that captures a key chord. -->
<script lang="ts">
  import { t } from "svelte-i18n";
  import {
    KEYBIND_BY_ID,
    conflictingId,
    formatKeys,
    isReserved,
  } from "../lib/keybindings";

  interface Props {
    id: string;
    /** The combo currently in effect, or `null` when unbound. */
    current: string | null;
    /** Every command's resolved combo, for conflict checks. */
    resolved: Record<string, string | null>;
    /** `null` reverts the command to its default; `""` unbinds it. */
    onSave: (key: string | null) => void;
    onReset: () => void;
    onClose: () => void;
  }

  let { id, current, resolved, onSave, onReset, onClose }: Props = $props();

  /** `undefined` = nothing captured yet; `""` = cleared; else a combo. */
  let captured = $state<string | undefined>(undefined);
  let error = $state("");

  function labelFor(commandId: string): string {
    const other = KEYBIND_BY_ID[commandId];
    if (!other) return commandId;
    return $t(
      other.labelKey,
      other.values ? { values: other.values } : undefined,
    );
  }

  /** Build a CodeMirror combo from a keydown, or null for a modifier press. */
  function comboFromEvent(event: KeyboardEvent): string | null {
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
    let name: string | null = null;
    const letter = /^Key([A-Z])$/.exec(event.code);
    const digit = /^Digit([0-9])$/.exec(event.code);
    if (letter) name = letter[1].toLowerCase();
    else if (digit) name = digit[1];
    else if (event.key === " ") name = "Space";
    else if (event.key.length === 1) name = event.key;
    else if (
      /^(Enter|Escape|Tab|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down)|F[0-9]{1,2})$/.test(
        event.key,
      )
    ) {
      name = event.key;
    }
    if (!name) return null;

    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push("Mod");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    parts.push(name);
    return parts.join("-");
  }

  function validate(combo: string): string {
    if (!combo) return "";
    if (isReserved(combo)) return $t("keybinds.reserved");
    const clash = conflictingId(id, combo, resolved);
    return clash
      ? $t("keybinds.conflict", { values: { other: labelFor(clash) } })
      : "";
  }

  function onKey(event: KeyboardEvent) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key === "Backspace") {
      captured = "";
      error = "";
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return;
    captured = combo;
    error = validate(combo);
  }

  const canSave = $derived(captured !== undefined && error === "");
  const shown = $derived(
    captured !== undefined ? captured : current ?? "",
  );

  // Capture-phase so the keystroke never reaches the app or editor.
  $effect(() => {
    const handler = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });
</script>

<div class="modal-overlay" role="presentation">
  <div class="modal keybind-capture" role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal-head">
      <span class="pane-title"
        >{$t("keybinds.edit")}: {labelFor(id)}</span
      >
    </div>
    <div class="modal-body">
      <p class="capture-keys mono" class:unbound={!shown}>
        {shown ? formatKeys(shown) : $t("keybinds.press")}
      </p>
      {#if error}<p class="error">{error}</p>{/if}
      <div class="row capture-actions">
        <button onclick={onReset}>{$t("keybinds.reset")}</button>
        <button
          onclick={() => {
            captured = "";
            error = "";
          }}>{$t("keybinds.clear")}</button
        >
        <span class="grow"></span>
        <button onclick={onClose}>{$t("keybinds.cancel")}</button>
        <button class="primary" disabled={!canSave} onclick={() => onSave(captured === "" ? "" : captured!)}>
          {$t("keybinds.save")}
        </button>
      </div>
    </div>
  </div>
</div>
