//! Shared types for the translation UI.
import type { ClauseSlot } from "../../lib/api";

/** A clause slot paired with a stable DOM id for drag-and-drop. */
export interface SlotItem {
  id: string;
  slot: ClauseSlot;
}

/** `dataTransfer` MIME type used when dragging palette chips onto the canvas. */
export const SLOT_DRAG_TYPE = "application/x-nueon-slot";
