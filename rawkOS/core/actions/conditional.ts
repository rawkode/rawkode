import { Action, type ActionContext, type SideEffect } from "../action.ts";
import type { SystemContext } from "../system-context.ts";

export type ConditionFunction = (system: SystemContext) => boolean;

export interface ConditionalConfig<T> {
	condition: ConditionFunction;
	action: Action<T>;
}

export class ConditionalAction<T> extends Action<ConditionalConfig<T>> {
	async plan(context: ActionContext): Promise<SideEffect[]> {
		if (!this.config.condition(context.system)) {
			return [];
		}

		return this.config.action.plan(context);
	}

	async apply(context: ActionContext): Promise<void> {
		if (!this.config.condition(context.system)) {
			return;
		}

		return this.config.action.apply(context);
	}
}
