import type { Phase } from "../machine/types.ts";

export interface Task {
  id: string;
  title: string;
  description: string;
  source: string;
  priority?: "low" | "medium" | "high" | "critical";
  labels?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskUpdate {
  status?: "in_progress" | "blocked" | "completed";
  comment?: string;
  labels?: string[];
}

export interface AdapterConfig {
  type: string;
  [key: string]: unknown;
}

export interface AdapterContext {
  tasks: Task[];
  additionalContext?: string;
  metadata?: Record<string, unknown>;
}

export interface AdapterHooks {
  onTaskSelected?(task: Task): Promise<void>;
  onPhaseTransition?(from: Phase, to: Phase, reason: string): Promise<void>;
  onTaskComplete?(task: Task, summary: string): Promise<void>;
}

export interface Adapter {
  name: string;
  initialize(config: AdapterConfig): Promise<void>;
  getContext(): Promise<AdapterContext>;
  updateTask?(taskId: string, update: TaskUpdate): Promise<void>;
  completeTask?(taskId: string): Promise<void>;
  hooks?: AdapterHooks;
}
