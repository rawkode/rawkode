import { join } from "path";
import type { RockoState, StateOptions } from "./types.ts";
import type { MachineContext } from "../machine/types.ts";

const STATE_VERSION = "1.0.0";
const STATE_DIR = ".rocko";
const STATE_FILE = "state.json";

function getStatePath(options?: StateOptions): string {
  const dir = options?.stateDir ?? join(process.cwd(), STATE_DIR);
  return join(dir, STATE_FILE);
}

export async function ensureStateDir(options?: StateOptions): Promise<void> {
  const dir = options?.stateDir ?? join(process.cwd(), STATE_DIR);
  await Bun.write(join(dir, ".gitkeep"), "");
}

export async function readState(options?: StateOptions): Promise<RockoState | null> {
  const statePath = getStatePath(options);
  const file = Bun.file(statePath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    const content = await file.text();
    return JSON.parse(content) as RockoState;
  } catch {
    return null;
  }
}

export async function writeState(
  context: MachineContext,
  options?: StateOptions
): Promise<void> {
  await ensureStateDir(options);
  const statePath = getStatePath(options);

  const state: RockoState = {
    version: STATE_VERSION,
    iteration: context.iteration,
    maxIterations: context.maxIterations,
    currentPhase: context.currentPhase,
    task: context.task,
    plan: context.plan,
    build: context.build,
    review: context.review,
    commit: context.commit,
    history: context.history,
    error: context.error,
    startedAt: context.history[0]?.timestamp instanceof Date
      ? context.history[0].timestamp.toISOString()
      : (context.history[0]?.timestamp as string) ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await Bun.write(statePath, JSON.stringify(state, null, 2));
}

export async function clearState(options?: StateOptions): Promise<void> {
  const statePath = getStatePath(options);
  const file = Bun.file(statePath);

  if (await file.exists()) {
    await Bun.write(statePath, "");
    const { unlink } = await import("fs/promises");
    await unlink(statePath);
  }
}

export function stateToContext(state: RockoState): MachineContext {
  return {
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    currentPhase: state.currentPhase,
    task: state.task,
    plan: state.plan,
    build: state.build,
    review: state.review,
    commit: state.commit,
    history: state.history.map((h) => ({
      ...h,
      timestamp: new Date(h.timestamp),
    })),
    error: state.error,
  };
}

export * from "./types.ts";
