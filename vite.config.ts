import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // Prevent Vite from obscuring Rust errors.
  clearScreen: false,
  build: {
    // CodeMirror is intentionally bundled into the editor chunk.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Tauri handles Rust sources; don't watch them here.
      ignored: ["**/src-tauri/**", "**/crates/**"],
    },
  },
});
