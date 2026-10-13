//! Classifies browser errors that are noise and must not reach the error bar.

/**
 * `ResizeObserver loop completed with undelivered notifications` is a benign
 * browser message (the observer callback resized something and the next frame
 * delivered it). It is not a bug in the app and hides real errors in the bar.
 */
export function isBenignError(message: string): boolean {
  return /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/.test(
    message.trim(),
  );
}
