import type { SystemContext } from "./system-context.ts";

export type SideEffectType =
	| "file_create"
	| "file_modify"
	| "file_delete"
	| "symlink_create"
	| "package_install"
	| "command_run"
	| "systemd_unit"
	| "dconf_write";

export interface SideEffect {
	type: SideEffectType;
	description: string;
	target?: string;
	metadata?: Record<string, unknown>;
	requiresElevation?: boolean;
}

export interface ActionContext {
	dryRun: boolean;
	verbose: boolean;
	targetModule?: string;
	system: SystemContext;
	moduleDir?: string;
	eventEmitter?: EventEmitter;
	currentModule?: string;
}

import { EventEmitter } from "node:events";

export abstract class Action<T = unknown> {
	constructor(
		public readonly name: string,
		public readonly description: string,
		protected readonly config: T,
	) {}

	abstract plan(context: ActionContext): Promise<SideEffect[]>;
	abstract apply(context: ActionContext): Promise<void>;

	protected async shouldRun(context: ActionContext): Promise<boolean> {
		return !context.dryRun;
	}
}

export class ActionRegistry {
	private static actions = new Map<string, typeof Action>();

	static register(name: string, actionClass: typeof Action) {
		this.actions.set(name, actionClass);
	}

	static get(name: string): typeof Action | undefined {
		return this.actions.get(name);
	}

	static getAll(): Map<string, typeof Action> {
		return new Map(this.actions);
	}
}
