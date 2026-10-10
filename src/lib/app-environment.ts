//! Build/runtime environment flags.
// Shim for SvelteKit's `$app/environment`, which svelte-splitpanes imports
// internally. This app is a plain Vite + Svelte app, so we provide the small
// surface it needs and alias `$app/environment` to this module in vite.config.
export const browser = typeof window !== "undefined";
export const building = false;
export const dev = false;
export const version = "";
