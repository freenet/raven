import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  // Enables TypeScript inside <script lang="ts"> blocks and SCSS in <style>.
  preprocess: vitePreprocess(),
};
