//! A small snapshot undo/redo stack, separate from the app's git history.

export interface History<T> {
  past: T[];
  future: T[];
}

const LIMIT = 100;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

/** Record `current` before an edit; any redo branch is discarded. */
export function pushHistory<T>(history: History<T>, current: T): History<T> {
  const past = [...history.past, current];
  if (past.length > LIMIT) past.shift();
  return { past, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undoStep<T>(
  history: History<T>,
  current: T,
): { history: History<T>; value: T } | null {
  if (!canUndo(history)) return null;
  const past = history.past.slice();
  const value = past.pop() as T;
  return { history: { past, future: [...history.future, current] }, value };
}

export function redoStep<T>(
  history: History<T>,
  current: T,
): { history: History<T>; value: T } | null {
  if (!canRedo(history)) return null;
  const future = history.future.slice();
  const value = future.pop() as T;
  return { history: { past: [...history.past, current], future }, value };
}
