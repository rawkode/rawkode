import { defineConfig } from "../../web-rich-editor/node_modules/vite/dist/node/index.js";
import vue from "../../web-rich-editor/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import { fileURLToPath } from "node:url";
import { d2Readiness } from "../../web-rich-editor/scripts/d2-readiness.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [d2Readiness(), vue()],
  resolve: { dedupe: ["vue"], alias: { vue: fileURLToPath(new URL("../../web-rich-editor/node_modules/vue/dist/vue.runtime.esm-bundler.js", import.meta.url)) } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
