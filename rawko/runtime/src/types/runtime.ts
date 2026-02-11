import type { ProviderName } from "./agent.ts";

export type ManagerMode = "delegate" | "council_vote" | "reply_user" | "await_user" | "wait";
export type AgentUiState =
  | "idle"
  | "manager_thinking"
  | "working"
  | "council"
  | "off_sick"
  | "probing";

export interface DelegationInstruction {
  agent: string;
  task: string;
  brief?: string;
  config?: DelegationTaskConfig;
}

export interface DelegationTaskConfig {
  runAfterSeconds?: number;
  maxRuntimeSeconds?: number;
  requiresDifferentAgent?: boolean;
}

export interface ManagerDirective {
  mode: ManagerMode;
  delegations?: DelegationInstruction[];
  reply?: string;
  notes?: string;
}

export interface WorkerResult {
  agentId: string;
  agentName: string;
  task: string;
  output: string;
}

export interface CouncilVote {
  agentId: string;
  agentName: string;
  verdict: "complete" | "incomplete";
  feedback: string;
}

export interface CouncilDecision {
  verdict: "complete" | "incomplete";
  feedback: string;
}

export interface UserMessage {
  text: string;
  at: string;
}

export interface ActiveTask {
  id: string;
  agentId: string;
  agentName: string;
  task: string;
  state: "running" | "waiting_review";
  startedAt: string;
}

export interface RecentTask {
  id: string;
  title: string;
  by: string;
  completedAt: string;
}

export interface OffSickAgent {
  agentId: string;
  agentName: string;
  reason: string;
  at: string;
}

export interface ManagerSnapshot {
  completed: boolean;
  cycle: number;
  activeTasks: ActiveTask[];
  recentTasks: RecentTask[];
  offSick: OffSickAgent[];
  agentStates: Record<string, AgentUiState>;
}

export type RuntimeEvent =
  | { type: "chat"; role: "manager" | "user" | "system"; text: string }
  | {
    type: "agent_state";
    agentId: string;
    agentName: string;
    state: AgentUiState;
    detail?: string;
  }
  | { type: "dispatch"; count: number; correlationId: string }
  | {
    type: "worker_result";
    agentId: string;
    agentName: string;
    task: string;
    output: string;
    correlationId: string;
  }
  | {
    type: "council_vote";
    agentId: string;
    agentName: string;
    verdict: "complete" | "incomplete";
    correlationId: string;
  }
  | { type: "completion"; complete: boolean; correlationId: string }
  | {
    type: "invoke_attempt";
    agentId: string;
    agentName: string;
    provider: ProviderName;
    model: string;
    attempt: number;
    maxAttempts: number;
    probe: boolean;
  }
  | {
    type: "invoke_failure";
    agentId: string;
    agentName: string;
    provider: ProviderName;
    model: string;
    attempt: number;
    maxAttempts: number;
    probe: boolean;
    reason: string;
  }
  | {
    type: "actor_message";
    id: string;
    from: string;
    to: string;
    messageType: string;
    correlationId?: string;
  };

export interface RuntimeEventEnvelope {
  seq: number;
  time: string;
  event: RuntimeEvent;
}
