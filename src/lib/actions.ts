/** Options for {@link autofocus}. */
export interface AutofocusOptions {
  /** Select the existing text (useful for rename prompts). */
  select?: boolean;
}

/**
 * Focus an input as soon as it is mounted, so creation/rename prompts are
 * ready for typing. Deferred one frame so it also survives parents that move
 * the node (e.g. portaled popovers) right after mounting.
 */
export function autofocus(
  node: HTMLInputElement | HTMLTextAreaElement,
  options: AutofocusOptions = {},
) {
  const frame = requestAnimationFrame(() => {
    node.focus({ preventScroll: true });
    if (options.select) node.select();
  });
  return {
    destroy() {
      cancelAnimationFrame(frame);
    },
  };
}
