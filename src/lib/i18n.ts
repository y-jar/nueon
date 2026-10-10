//! Locale initialisation for svelte-i18n.
import { addMessages, init, locale, t } from "svelte-i18n";

import en from "../locales/en.json";

/** Register the built-in catalogs and initialise the locale. */
export async function initI18n(): Promise<void> {
  addMessages("en", en);
  await init({ fallbackLocale: "en", initialLocale: "en" });
}

export { locale, t };
