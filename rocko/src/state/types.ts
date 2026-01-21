import type {
  Phase,
  PlanOutput,
  BuildOutput,
  ReviewOutput,
  CommitOutput,
  PhaseHistory,
} from "../machine/types.ts";
import type { Task } from "../adapter/types.ts";

export interface RockoState {
  version: string;
  iteration: number;
  maxIterations: number;
  currentPhase: Phase;
  task?: Task;
  plan?: PlanOutput;
  build?: BuildOutput;
  review?: ReviewOutput;
  commit?: CommitOutput;
  history: PhaseHistory[];
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface StateOptions {
  stateDir?: string;
}
