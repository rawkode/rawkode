import react from "@astrojs/react";
import stylex from "@stylexjs/unplugin/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
	outDir: "./dist/client",
	integrations: [react()],
	vite: {
		plugins: [
			stylex({
				devMode: "full",
				devPersistToDisk: true,
				useCSSLayers: true,
			}),
		],
		build: {
			sourcemap: true,
		},
	},
});
