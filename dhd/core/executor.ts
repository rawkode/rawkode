import type { Module } from "./module.ts";
import type { ModuleDAG } from "./dag.ts";
import type { ActionContext, SideEffect } from "./action.ts";
import { EventEmitter } from "node:events";
import { getTelemetry } from "./telemetry.ts";
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { Span } from '@opentelemetry/api';

export interface ExecutorEvents {
	moduleStart: (module: Module) => void;
	moduleComplete: (module: Module) => void;
	moduleError: (module: Module, error: Error) => void;
	moduleOutput: (moduleName: string, data: string) => void;
	moduleNeedsInput: (moduleName: string) => void;
	groupStart: (modules: Module[]) => void;
	groupComplete: (modules: Module[]) => void;
	planComplete: (effects: Map<string, SideEffect[]>) => void;
}

export class ModuleExecutor extends EventEmitter {
	private maxConcurrency = 8;
	private telemetry?: ReturnType<typeof getTelemetry>;
	private executionSpan?: Span;

	constructor(private dag: ModuleDAG) {
		super();
	}

	async plan(context: ActionContext): Promise<Map<string, SideEffect[]>> {
		// Initialize telemetry if available
		try {
			this.telemetry = getTelemetry();
		} catch {}
		
		const planSpan = this.telemetry?.startExecutionSpan('rawkos.plan');
		const effects = new Map<string, SideEffect[]>();
		const groups = this.dag.getConcurrentGroups();

		try {
			for (let i = 0; i < groups.length; i++) {
				const group = groups[i];
				const groupSpan = this.telemetry?.startGroupSpan(i, group.length, planSpan);
				
				await Promise.all(
					group.map(async (module) => {
						const moduleSpan = this.telemetry?.startModuleSpan(module.name, groupSpan);
						try {
							const moduleEffects = await module.plan(context);
							effects.set(module.name, moduleEffects);
							if (moduleSpan) {
								this.telemetry?.recordSideEffects(moduleSpan, moduleEffects);
								this.telemetry?.endSpanSuccess(moduleSpan);
							}
						} catch (error) {
							console.error(`Failed to plan module ${module.name}:`, error);
							this.telemetry?.logError(module.name, error as Error);
							if (moduleSpan) {
								this.telemetry?.endSpanError(moduleSpan, error as Error);
							}
							effects.set(module.name, []);
						}
					}),
				);
				
				if (groupSpan) {
					this.telemetry?.endSpanSuccess(groupSpan);
				}
			}

			if (planSpan) {
				this.telemetry?.endSpanSuccess(planSpan);
			}
		} catch (error) {
			if (planSpan) {
				this.telemetry?.endSpanError(planSpan, error as Error);
			}
			throw error;
		}

		this.emit("planComplete", effects);
		return effects;
	}

	async apply(context: ActionContext, plannedEffects?: Map<string, SideEffect[]>): Promise<void> {
		// Initialize telemetry if available
		try {
			this.telemetry = getTelemetry();
		} catch {}
		
		this.executionSpan = this.telemetry?.startExecutionSpan('rawkos.apply');
		
		// If we have planned effects, filter modules to only those with changes
		let modulesToApply: Set<string> | undefined;
		if (plannedEffects) {
			modulesToApply = new Set<string>();
			for (const [moduleName, effects] of plannedEffects) {
				if (effects.length > 0) {
					modulesToApply.add(moduleName);
				}
			}
		}

		const groups = this.dag.getConcurrentGroups();

		try {
			for (let i = 0; i < groups.length; i++) {
				const group = groups[i];
				// Filter group to only include modules with effects
				const filteredGroup = modulesToApply 
					? group.filter(m => modulesToApply.has(m.name))
					: group;

				if (filteredGroup.length === 0) continue;

				const groupSpan = this.telemetry?.startGroupSpan(i, filteredGroup.length, this.executionSpan);

				// Process group with limited concurrency
				const queue = [...filteredGroup];
				const runningPromises = new Map<Module, Promise<void>>();
				const completed = new Set<Module>();
				const errors = new Map<Module, Error>();

				this.emit("groupStart", filteredGroup);

				// Process modules with max concurrency limit
				while (queue.length > 0 || runningPromises.size > 0) {
					// Start new modules up to concurrency limit
					while (runningPromises.size < this.maxConcurrency && queue.length > 0) {
						const module = queue.shift()!;
						
						// Create and track the promise
						const promise = (async () => {
							const moduleSpan = this.telemetry?.startModuleSpan(module.name, groupSpan);
							try {
								this.emit("moduleStart", module);
								// Pass event emitter and telemetry in context
								const moduleContext = {
									...context,
									eventEmitter: this,
									telemetry: this.telemetry,
									moduleSpan
								};
								await module.apply(moduleContext);
								if (moduleSpan) {
									this.telemetry?.endSpanSuccess(moduleSpan);
								}
								this.emit("moduleComplete", module);
								completed.add(module);
							} catch (error) {
								this.telemetry?.logError(module.name, error as Error);
								if (moduleSpan) {
									this.telemetry?.endSpanError(moduleSpan, error as Error);
								}
								this.emit("moduleError", module, error as Error);
								errors.set(module, error as Error);
							} finally {
								runningPromises.delete(module);
							}
						})();
						
						runningPromises.set(module, promise);
					}

					// Wait for at least one module to complete
					if (runningPromises.size > 0) {
						await Promise.race(runningPromises.values());
					}
				}

				// If any errors occurred, throw the first one
				if (errors.size > 0) {
					if (groupSpan) {
						this.telemetry?.endSpanError(groupSpan, errors.values().next().value);
					}
					throw errors.values().next().value;
				}

				if (groupSpan) {
					this.telemetry?.endSpanSuccess(groupSpan);
				}
				this.emit("groupComplete", filteredGroup);
			}
			
			if (this.executionSpan) {
				this.telemetry?.endSpanSuccess(this.executionSpan);
			}
		} catch (error) {
			if (this.executionSpan) {
				this.telemetry?.endSpanError(this.executionSpan, error as Error);
			}
			throw error;
		}
	}

	on<K extends keyof ExecutorEvents>(
		event: K,
		listener: ExecutorEvents[K],
	): this {
		// Also log module output to telemetry
		if (event === 'moduleOutput') {
			const originalListener = listener as ExecutorEvents['moduleOutput'];
			const wrappedListener = (moduleName: string, data: string) => {
				this.telemetry?.logModuleOutput(moduleName, data, SeverityNumber.INFO);
				originalListener(moduleName, data);
			};
			return super.on(event, wrappedListener as any);
		}
		return super.on(event, listener as any);
	}
}