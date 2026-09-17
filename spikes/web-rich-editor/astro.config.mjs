import { defineConfig } from "astro/config";
import vue from "@astrojs/vue";
import node from "@astrojs/node";
import { d2Readiness } from "./scripts/d2-readiness.mjs";

export default defineConfig({
	integrations: [vue()],
	vite: { plugins: [d2Readiness()] },
	output: "server",
	adapter: node({ mode: "standalone" }),
	server: { host: "127.0.0.1", port: 4327 },
});
