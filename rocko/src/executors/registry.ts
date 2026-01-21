import type { Executor, ExecutorConfig, ExecutorFactory } from "./types.ts";

const executors = new Map<string, ExecutorFactory>();

export function registerExecutor(type: string, factory: ExecutorFactory): void {
  executors.set(type, factory);
}

export async function createExecutor(config: ExecutorConfig): Promise<Executor> {
  const factory = executors.get(config.type);
  if (!factory) {
    throw new Error(`Unknown executor type: ${config.type}`);
  }
  const executor = await factory(config);
  await executor.initialize(config);
  return executor;
}

export async function loadBuiltinExecutors(): Promise<void> {
  const { createDirectExecutor } = await import("./direct.ts");
  const { createACPExecutor } = await import("./acp.ts");

  registerExecutor("direct", createDirectExecutor);
  registerExecutor("acp", createACPExecutor);
}

export { executors };
