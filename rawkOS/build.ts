#!/usr/bin/env bun
import { generateModuleRegistry } from "@rawkode/dhd/core/build/generate-registry";
import { $ } from "bun";
import fs from "node:fs/promises";

async function build() {
	console.log("🔨 Building standalone rawkOS binary...");
	
	// Generate module registry
	await generateModuleRegistry({
		baseDir: ".",
		pattern: "**/mod.ts",
		ignore: ["node_modules/**", "dist/**", "build/**"],
		outputPath: "module-registry.ts",
	});
	
	// Create the CLI file
	const cliContent = `#!/usr/bin/env bun
import { createStandaloneCLI } from "@rawkode/dhd/core/build";
import { MODULE_REGISTRY, MODULE_PATHS, MODULE_ABSOLUTE_PATHS } from "./module-registry.ts";

// Make absolute paths available globally for the standalone loader
(globalThis as any).MODULE_ABSOLUTE_PATHS = MODULE_ABSOLUTE_PATHS;

createStandaloneCLI(MODULE_REGISTRY, MODULE_PATHS, {
	name: "rawkos",
	description: "rawkOS configuration management",
	version: "1.0.0",
});
`;
	
	await fs.writeFile("cli-standalone.ts", cliContent);
	
	// Build the binary
	await $`bun build cli-standalone.ts --compile --outfile rawkos --minify-syntax --minify-whitespace`;
	
	// Clean up
	await $`rm -f module-registry.ts cli-standalone.ts`;
	
	console.log("✅ Built rawkos binary!");
}

build().catch(console.error);