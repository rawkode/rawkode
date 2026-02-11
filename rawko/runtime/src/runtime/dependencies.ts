import type { AgentPool } from "../types/agent.ts";
import type { EventStore } from "./event_store.ts";
import type { AgentExecutor } from "./executor.ts";

export interface RuntimeDependencies {
  pool: AgentPool;
  executor: AgentExecutor;
  events: EventStore;
  maxParallelWorkers: number;
}

let runtimeDeps: RuntimeDependencies | null = null;

export function setRuntimeDependencies(deps: RuntimeDependencies): void {
  runtimeDeps = deps;
}

export function getRuntimeDependencies(): RuntimeDependencies {
  if (!runtimeDeps) {
    throw new Error("Runtime dependencies have not been initialized");
  }
  return runtimeDeps;
}
