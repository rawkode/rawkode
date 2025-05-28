import { Module, type ModuleLoader, type ModuleDefinition } from "./module.ts";
import { existsSync } from "node:fs";
import { glob } from "glob";
import path from "node:path";

export class FileSystemModuleLoader implements ModuleLoader {
	async load(modulePath: string): Promise<Module> {
		const fullPath = path.resolve(modulePath);

		if (!existsSync(fullPath)) {
			throw new Error(`Module not found: ${fullPath}`);
		}

		const moduleExports = await import(fullPath);

		if (!moduleExports.default) {
			throw new Error(
				`Module ${fullPath} must export a default module definition`,
			);
		}

		const definition = moduleExports.default as ModuleDefinition;

		if (!definition.metadata || !definition.metadata.name) {
			throw new Error(`Module ${fullPath} must have metadata with a name`);
		}

		return new Module(fullPath, definition);
	}

	async discover(basePath: string): Promise<Module[]> {
		const pattern = path.join(basePath, "**/mod.ts");
		const files = await glob(pattern, {
			ignore: ["node_modules/**", "dist/**", "build/**", "core/**", "utils/**"],
		});

		const modules: Module[] = [];

		for (const file of files) {
			try {
				const module = await this.load(file);
				modules.push(module);
			} catch (error) {
				console.warn(`Failed to load module ${file}:`, error);
			}
		}

		return modules;
	}
}
