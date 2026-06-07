/**
 * main.ts — Svelte entry point. Replaces index.ts as the module the HTML
 * bootstraps. Keeps the boot-time side effects index.ts ran BEFORE any render
 * (theme, locked design tokens, document.title), imports the global SCSS, then
 * mounts App.svelte and kicks off the connection via the store's start().
 */
import "./scss/styles.scss";
import { mount } from "svelte";
import { APP_NAME } from "./branding";
import { initTheme } from "./theme";
import App from "./App.svelte";
import { start } from "./stores/freenet";

document.title = APP_NAME;

// Apply persisted theme synchronously, BEFORE any render — avoids FOUC and
// guarantees onboarding/splash also respect saved preference.
initTheme();

// Editorial design tokens are intentionally locked at boot (not user-tweakable).
// See _raven.scss for matching selectors.
const root = document.documentElement;
root.dataset.size = "regular";
root.dataset.actions = "friendly";
root.dataset.surface = "warm";
root.dataset.avatars = "ink";

const app = mount(App, {
  target: document.getElementById("app")!,
});

// Boot the connection (offline-mode aware inside the store).
start();

export default app;
