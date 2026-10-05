import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { initI18n } from "./lib/i18n";

const target = document.getElementById("app");
if (!target) {
  throw new Error("missing #app mount point");
}

const app = initI18n().then(() => mount(App, { target }));

export default app;
