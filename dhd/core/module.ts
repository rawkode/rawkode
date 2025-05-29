import type { Action, ActionContext, SideEffect } from "./action.ts";
import path from "node:path";

export interface ModuleMetadata {
	name: string;
	description?: string;
	dependencies?: string[];
	tags?: string[];
}

export interface ModuleDefinition {
	metadata: ModuleMetadata;
	actions: Action[];
}

export class Module {
	constructor(
		public readonly path: string,
		public readonly definition: ModuleDefinition,
	) {}

	get name(): string {
		return this.definition.metadata.name;
	}

	get dependencies(): string[] {
		return this.definition.metadata.dependencies || [];
	}

	get directory(): string {
		return path.dirname(this.path);
	}

	async plan(context: ActionContext): Promise<SideEffect[]> {
		const effects: SideEffect[] = [];
		const moduleContext = { ...context, moduleDir: this.directory };

		for (const action of this.definition.actions) {
			const actionEffects = await action.plan(moduleContext);
			effects.push(...actionEffects);
		}

		return effects;
	}

	async apply(context: ActionContext): Promise<void> {
		const moduleContext = { 
			...context, 
			moduleDir: this.directory,
			currentModule: this.name 
		};

		for (const action of this.definition.actions) {
			if (context.verbose) {
				console.log(`[${this.name}] Running action: ${action.name}`);
			}
			await action.apply(moduleContext);
		}
	}
}

export interface ModuleLoader {
	load(path: string): Promise<Module>;
	discover(basePath: string): Promise<Module[]>;
}
