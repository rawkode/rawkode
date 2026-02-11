import { actor, createMemoryDriver, setup } from "rivetkit";
import { getRuntimeDependencies } from "../runtime/dependencies.ts";
import { createEnvelope } from "../runtime/envelope.ts";
import {
  buildManagerDirectiveOutputSpec,
  COUNCIL_DECISION_OUTPUT_SPEC,
} from "../runtime/structured.ts";
import type {
  ActiveTask,
  CouncilDecision,
  CouncilVote,
  ManagerDirective,
  ManagerSnapshot,
  RecentTask,
  UserMessage,
  WorkerResult,
} from "../types/runtime.ts";
import type { AgentDefinition } from "../types/agent.ts";

export const MANAGER_ACTOR_KEY = ["main"];
export const USER_ACTOR_KEY = ["main"];
export const HEALTH_ACTOR_KEY = ["main"];

interface BootstrapInput {
  initialObjective?: string;
  maxParallelWorkers?: number;
}

interface ManagerActorState {
  initialized: boolean;
  objective: string | null;
  completed: boolean;
  stopping: boolean;
  cycle: number;
  maxParallelWorkers: number;
  managerMemory: string[];
  pendingUserMessages: UserMessage[];
  workerOutputs: WorkerResult[];
  dissentFeedback: CouncilVote[];
  pendingCouncilVote: {
    correlationId: string;
    expected: number;
    received: CouncilVote[];
  } | null;
  activeTasks: ActiveTask[];
  recentTasks: RecentTask[];
}

interface WorkerRunTaskInput {
  taskId: string;
  agentId: string;
  task: string;
  brief: string;
  config?: {
    runAfterSeconds?: number;
    maxRuntimeSeconds?: number;
    requiresDifferentAgent?: boolean;
  };
  correlationId: string;
}

interface CouncilVoteInput {
  agentId: string;
  correlationId: string;
  objective: string;
  workerOutputs: Array<{ agentName: string; task: string; output: string }>;
}

interface WorkerResultMessage {
  taskId: string;
  correlationId: string;
  result: WorkerResult;
}

interface CouncilVoteMessage {
  correlationId: string;
  vote: CouncilVote;
}

interface ActorClientContext {
  client: () => {
    manager: {
      getOrCreate: (key: string[]) => {
        enqueueUserMessage: (text: string) => Promise<unknown>;
        enqueueWorkerResult: (input: WorkerResultMessage) => Promise<unknown>;
        enqueueCouncilVote: (input: CouncilVoteMessage) => Promise<unknown>;
      };
    };
    worker: {
      getOrCreate: (key: string[]) => {
        runTask: (input: WorkerRunTaskInput) => Promise<unknown>;
      };
    };
    council: {
      getOrCreate: (key: string[]) => {
        vote: (input: CouncilVoteInput) => Promise<unknown>;
      };
    };
  };
}

// Rivet requires a positive action timeout; use the max safe timer window (~24.8 days)
// so long-running agent work behaves as effectively unbounded in practice.
const UNBOUNDED_ACTION_TIMEOUT_MS = 2_147_483_647;

function createManagerState(): ManagerActorState {
  return {
    initialized: false,
    objective: null,
    completed: false,
    stopping: false,
    cycle: 0,
    maxParallelWorkers: 4,
    managerMemory: [],
    pendingUserMessages: [],
    workerOutputs: [],
    dissentFeedback: [],
    pendingCouncilVote: null,
    activeTasks: [],
    recentTasks: [],
  };
}

const manager = actor({
  options: {
    noSleep: true,
    actionTimeout: UNBOUNDED_ACTION_TIMEOUT_MS,
  },
  state: createManagerState(),
  actions: {
    bootstrap(_c, input: BootstrapInput = {}) {
      const state = _c.state as ManagerActorState;
      if (state.initialized) {
        return { initialized: true };
      }

      state.initialized = true;
      state.maxParallelWorkers = Math.max(1, input.maxParallelWorkers ?? 4);

      if (input.initialObjective?.trim()) {
        const objective = input.initialObjective.trim();
        state.objective = objective;
        state.completed = false;
        state.pendingUserMessages.push({ text: objective, at: new Date().toISOString() });
        state.managerMemory.push(`Initial user message: ${objective}`);
        const deps = getRuntimeDependencies();
        deps.events.append({
          type: "chat",
          role: "user",
          text: objective,
        });
      }

      return { initialized: true };
    },

    stop(c) {
      const state = c.state as ManagerActorState;
      state.stopping = true;
      return { stopping: true };
    },

    setObjective(_c, text: string) {
      const state = _c.state as ManagerActorState;
      const objective = String(text ?? "").trim();
      if (!objective) {
        return { accepted: false };
      }

      state.objective = objective;
      state.completed = false;
      state.pendingUserMessages.push({ text: objective, at: new Date().toISOString() });
      state.managerMemory.push(`User message (objective alias): ${objective}`);

      const deps = getRuntimeDependencies();
      deps.events.append({
        type: "chat",
        role: "user",
        text: objective,
      });

      truncateStateMemory(state);
      return { accepted: true, objective };
    },

    enqueueUserMessage(_c, text: string) {
      const state = _c.state as ManagerActorState;
      const trimmed = String(text ?? "").trim();
      if (!trimmed) {
        return { accepted: false };
      }

      const deps = getRuntimeDependencies();
      deps.events.append({
        type: "chat",
        role: "user",
        text: trimmed,
      });

      state.pendingUserMessages.push({ text: trimmed, at: new Date().toISOString() });
      state.completed = false;
      state.managerMemory.push(`User message: ${trimmed}`);

      truncateStateMemory(state);
      return { accepted: true };
    },

    enqueueWorkerResult(c, input: WorkerResultMessage) {
      const state = c.state as ManagerActorState;
      const deps = getRuntimeDependencies();

      state.activeTasks = state.activeTasks.filter((task) => task.id !== input.taskId);
      state.workerOutputs.push(input.result);
      state.managerMemory.push(
        `Worker \"${input.result.agentName}\" result for \"${input.result.task}\":\n${input.result.output}`,
      );
      state.recentTasks.unshift({
        id: crypto.randomUUID(),
        title: truncate(input.result.task, 120),
        by: input.result.agentName,
        completedAt: new Date().toISOString(),
      });
      state.recentTasks = state.recentTasks.slice(0, 50);

      deps.events.append({
        type: "worker_result",
        agentId: input.result.agentId,
        agentName: input.result.agentName,
        task: input.result.task,
        output: input.result.output,
        correlationId: input.correlationId,
      });
      deps.events.append({
        type: "chat",
        role: "manager",
        text: buildWorkerResultChatMessage(input.result),
      });

      truncateStateMemory(state);
      return { accepted: true };
    },

    enqueueCouncilVote(c, input: CouncilVoteMessage) {
      const state = c.state as ManagerActorState;
      recordCouncilVote(state, input.vote, input.correlationId);
      truncateStateMemory(state);
      return { accepted: true };
    },

    async runCycle(c) {
      const state = c.state as ManagerActorState;
      const deps = getRuntimeDependencies();

      if (!state.initialized || state.stopping) {
        return { status: "stopped" };
      }

      if (state.activeTasks.length > 0 && state.pendingUserMessages.length === 0) {
        return { status: "workers_in_flight" };
      }

      if (state.pendingCouncilVote && state.pendingUserMessages.length === 0) {
        return { status: "council_in_flight" };
      }

      if (
        state.pendingUserMessages.length === 0 &&
        state.activeTasks.length === 0 &&
        !state.pendingCouncilVote
      ) {
        return { status: "idle" };
      }

      state.cycle += 1;
      deps.events.append({
        type: "agent_state",
        agentId: deps.pool.manager.id,
        agentName: deps.pool.manager.name,
        state: "manager_thinking",
      });

      const delegationRequirements = deriveDelegationRequirements(state);
      let directive: ManagerDirective;
      try {
        directive = await deps.executor.invokeStructured(
          deps.pool.manager,
          buildManagerPrompt(state, delegationRequirements),
          buildManagerDirectiveOutputSpec({
            minDelegations: delegationRequirements.minDelegations,
          }),
        );
      } catch (error) {
        deps.events.append({
          type: "chat",
          role: "system",
          text: `Manager invocation failed: ${stringifyError(error)}`,
        });
        deps.events.append({
          type: "agent_state",
          agentId: deps.pool.manager.id,
          agentName: deps.pool.manager.name,
          state: deps.executor.isOffSick(deps.pool.manager) ? "off_sick" : "idle",
        });
        await sleep(1000);
        return { status: "manager_error" };
      }

      deps.events.append({
        type: "agent_state",
        agentId: deps.pool.manager.id,
        agentName: deps.pool.manager.name,
        state: deps.executor.isOffSick(deps.pool.manager) ? "off_sick" : "idle",
      });

      await handleDirective(c, state, directive);
      truncateStateMemory(state);

      return {
        status: "ok",
        mode: directive.mode,
        cycle: state.cycle,
      };
    },

    getSnapshot(c): ManagerSnapshot {
      const state = c.state as ManagerActorState;
      const deps = getRuntimeDependencies();

      const agentStates: Record<string, string> = {};
      const recentEvents = deps.events.listSince(
        Math.max(0, deps.events.latestSeq() - 5_000),
        5_000,
      );
      for (const envelope of recentEvents) {
        if (envelope.event.type === "agent_state") {
          agentStates[envelope.event.agentId] = envelope.event.state;
        }
      }

      return {
        completed: state.completed,
        cycle: state.cycle,
        activeTasks: [...state.activeTasks],
        recentTasks: [...state.recentTasks],
        offSick: deps.executor.listOffSick(deps.pool.byId),
        agentStates: agentStates as Record<string, ManagerSnapshot["agentStates"][string]>,
      };
    },
  },
});

const worker = actor({
  options: {
    noSleep: true,
    actionTimeout: UNBOUNDED_ACTION_TIMEOUT_MS,
  },
  actions: {
    async runTask(c, input: {
      taskId: string;
      agentId: string;
      task: string;
      brief: string;
      config?: {
        runAfterSeconds?: number;
        maxRuntimeSeconds?: number;
        requiresDifferentAgent?: boolean;
      };
      correlationId: string;
    }) {
      const deps = getRuntimeDependencies();
      const agent = deps.pool.byId.get(input.agentId);
      if (!agent) {
        return { accepted: false, reason: `Worker agent not found: ${input.agentId}` };
      }

      deps.events.append({
        type: "agent_state",
        agentId: agent.id,
        agentName: agent.name,
        state: "working",
        detail: input.task,
      });

      let result: WorkerResult;
      try {
        const output = await invokeWorkerWithOptionalTimeout(
          () => deps.executor.invoke(agent, buildWorkerPrompt(input)),
          input.config?.maxRuntimeSeconds,
        );
        deps.events.append({
          type: "agent_state",
          agentId: agent.id,
          agentName: agent.name,
          state: deps.executor.isOffSick(agent) ? "off_sick" : "idle",
        });
        result = {
          agentId: agent.id,
          agentName: agent.name,
          task: input.task,
          output,
        };
      } catch (error) {
        deps.events.append({
          type: "agent_state",
          agentId: agent.id,
          agentName: agent.name,
          state: deps.executor.isOffSick(agent) ? "off_sick" : "idle",
        });
        result = {
          agentId: agent.id,
          agentName: agent.name,
          task: input.task,
          output: `Worker failed: ${stringifyError(error)}`,
        };
      }

      const client = c.client() as unknown as ReturnType<ActorClientContext["client"]>;
      const envelope = createEnvelope({
        from: "worker_actor",
        to: "manager_actor",
        type: "worker.result",
        correlationId: input.correlationId,
        content: {
          taskId: input.taskId,
          agentId: result.agentId,
        },
      });

      deps.events.append({
        type: "actor_message",
        id: envelope.id,
        from: envelope.from,
        to: envelope.to,
        messageType: envelope.type,
        correlationId: input.correlationId,
      });

      const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
      await managerHandle.enqueueWorkerResult({
        taskId: input.taskId,
        correlationId: input.correlationId,
        result,
      });

      return { accepted: true };
    },
  },
});

const council = actor({
  options: {
    noSleep: true,
    actionTimeout: UNBOUNDED_ACTION_TIMEOUT_MS,
  },
  actions: {
    async vote(c, input: {
      agentId: string;
      correlationId: string;
      objective: string;
      workerOutputs: Array<{ agentName: string; task: string; output: string }>;
    }) {
      const deps = getRuntimeDependencies();
      const agent = deps.pool.byId.get(input.agentId);
      if (!agent) {
        return { accepted: false, reason: `Council agent not found: ${input.agentId}` };
      }

      deps.events.append({
        type: "agent_state",
        agentId: agent.id,
        agentName: agent.name,
        state: "council",
      });

      let vote: CouncilVote;
      try {
        const decision = await deps.executor.invokeStructured(
          agent,
          buildCouncilPrompt(input.objective, input.workerOutputs),
          COUNCIL_DECISION_OUTPUT_SPEC,
        );
        deps.events.append({
          type: "agent_state",
          agentId: agent.id,
          agentName: agent.name,
          state: deps.executor.isOffSick(agent) ? "off_sick" : "idle",
        });
        vote = structuredCouncilVote(agent.id, agent.name, decision);
      } catch (error) {
        deps.events.append({
          type: "agent_state",
          agentId: agent.id,
          agentName: agent.name,
          state: deps.executor.isOffSick(agent) ? "off_sick" : "idle",
        });
        vote = {
          agentId: agent.id,
          agentName: agent.name,
          verdict: "incomplete",
          feedback: `Council invocation failed: ${stringifyError(error)}`,
        };
      }

      const client = c.client() as unknown as ReturnType<ActorClientContext["client"]>;
      const envelope = createEnvelope({
        from: "council_actor",
        to: "manager_actor",
        type: "council.result",
        correlationId: input.correlationId,
        content: { agentId: vote.agentId },
      });

      deps.events.append({
        type: "actor_message",
        id: envelope.id,
        from: envelope.from,
        to: envelope.to,
        messageType: envelope.type,
        correlationId: input.correlationId,
      });

      const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
      await managerHandle.enqueueCouncilVote({
        correlationId: input.correlationId,
        vote,
      });

      return { accepted: true };
    },
  },
});

const user = actor({
  options: {
    noSleep: true,
    actionTimeout: UNBOUNDED_ACTION_TIMEOUT_MS,
  },
  actions: {
    async submit(c, text: string) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) {
        return { accepted: false };
      }

      const client = c.client() as unknown as ReturnType<ActorClientContext["client"]>;
      const envelope = createEnvelope({
        from: "user_actor",
        to: "manager_actor",
        type: "user.message",
        content: { text: trimmed },
      });

      const deps = getRuntimeDependencies();
      deps.events.append({
        type: "actor_message",
        id: envelope.id,
        from: envelope.from,
        to: envelope.to,
        messageType: envelope.type,
      });

      const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
      await managerHandle.enqueueUserMessage(trimmed);
      return { accepted: true };
    },
  },
});

const health = actor({
  options: {
    noSleep: true,
    actionTimeout: UNBOUNDED_ACTION_TIMEOUT_MS,
  },
  actions: {
    async tick() {
      const deps = getRuntimeDependencies();
      const recovered: string[] = [];

      for (const id of deps.executor.getOffSickIds()) {
        const agent = deps.pool.byId.get(id);
        if (!agent) {
          continue;
        }

        deps.events.append({
          type: "agent_state",
          agentId: agent.id,
          agentName: agent.name,
          state: "probing",
        });

        const alive = await deps.executor.probe(agent);
        if (alive) {
          recovered.push(agent.name);
          deps.events.append({
            type: "agent_state",
            agentId: agent.id,
            agentName: agent.name,
            state: "idle",
          });
          deps.events.append({
            type: "chat",
            role: "system",
            text: `${agent.name} recovered and is available`,
          });
        } else {
          deps.events.append({
            type: "agent_state",
            agentId: agent.id,
            agentName: agent.name,
            state: "off_sick",
            detail: deps.executor.getOffSickReason(agent) ?? "probe failed",
          });
        }
      }

      return { recovered };
    },
  },
});

export const rawkoRegistry = setup({
  use: {
    manager,
    worker,
    council,
    user,
    health,
  },
  driver: createMemoryDriver(),
  serveManager: false,
  noWelcome: true,
});

export type RawkoRegistry = typeof rawkoRegistry;

async function handleDirective(
  c: { client: () => unknown },
  state: ManagerActorState,
  directive: ManagerDirective,
): Promise<void> {
  const deps = getRuntimeDependencies();

  switch (directive.mode) {
    case "reply_user": {
      if (directive.reply?.trim()) {
        deps.events.append({
          type: "chat",
          role: "manager",
          text: directive.reply.trim(),
        });
        state.managerMemory.push(`Manager reply: ${directive.reply.trim()}`);
      }
      consumeProcessedUserMessage(state);
      return;
    }
    case "await_user": {
      if (directive.reply?.trim()) {
        deps.events.append({
          type: "chat",
          role: "manager",
          text: directive.reply.trim(),
        });
        state.managerMemory.push(`Manager reply (await_user): ${directive.reply.trim()}`);
      }
      consumeProcessedUserMessage(state);
      return;
    }
    case "delegate": {
      const dispatched = runDelegations(c, state, directive);
      if (dispatched) {
        consumeProcessedUserMessage(state);
      }
      return;
    }
    case "council_vote": {
      runCouncilVote(c, state);
      return;
    }
    case "wait":
    default:
      state.managerMemory.push(`Manager chose wait on cycle ${state.cycle}.`);
      await sleep(250);
  }
}

function consumeProcessedUserMessage(state: ManagerActorState): void {
  const processed = state.pendingUserMessages.shift();
  if (!processed?.text?.trim()) {
    return;
  }

  state.objective = processed.text.trim();
  state.completed = false;
}

function currentObjectiveContext(state: ManagerActorState): string {
  const pending = state.pendingUserMessages[0]?.text?.trim();
  if (pending) {
    return pending;
  }

  const activeTask = state.activeTasks[0]?.task?.trim();
  if (activeTask) {
    return activeTask;
  }

  const pinned = state.objective?.trim();
  if (pinned) {
    return pinned;
  }

  return "(none)";
}

function deriveDelegationRequirements(
  state: ManagerActorState,
): { minDelegations: number; requireDifferentAgent: boolean } {
  const text = state.pendingUserMessages[0]?.text?.trim() ?? "";
  if (!text) {
    return { minDelegations: 1, requireDifferentAgent: false };
  }

  const ordinalMatches = text.match(
    /\b(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth(?:ly)?)\b/gi,
  ) ?? [];
  const ordinalCount = new Set(ordinalMatches.map((part) => part.toLowerCase())).size;

  const listItemCount = text.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g)?.length ?? 0;
  const minDelegations = Math.max(
    1,
    ordinalCount,
    listItemCount >= 2 ? listItemCount : 1,
  );
  const requireDifferentAgent = /\b(another|different)\s+agent\b/i.test(text);

  return { minDelegations, requireDifferentAgent };
}

function runDelegations(
  c: { client: () => unknown },
  state: ManagerActorState,
  directive: ManagerDirective,
): boolean {
  const deps = getRuntimeDependencies();
  const requested = directive.delegations ?? [];
  const byName = new Map(deps.pool.all.map((agent) => [agent.name, agent]));

  const assignments = requested
    .map((entry) => ({
      instruction: entry,
      task: entry.task.trim(),
      agent: byName.get(entry.agent),
    }))
    .filter((entry) => entry.agent && entry.task.length > 0)
    .map((entry) =>
      entry as {
        instruction: NonNullable<ManagerDirective["delegations"]>[number];
        task: string;
        agent: AgentDefinition;
      }
    )
    .filter((entry) => entry.agent.id !== deps.pool.manager.id)
    .filter((entry) => !deps.executor.isOffSick(entry.agent));

  if (assignments.length === 0) {
    state.managerMemory.push(
      "Manager requested delegation, but no valid available workers were found.",
    );
    return false;
  }

  const requirements = deriveDelegationRequirements(state);
  if (assignments.length < requirements.minDelegations) {
    state.managerMemory.push(
      `Manager delegation invalid: expected at least ${requirements.minDelegations} task(s) for the immediate request.`,
    );
    return false;
  }

  if (requirements.requireDifferentAgent) {
    const uniqueAgentCount = new Set(assignments.map((assignment) => assignment.agent.id)).size;
    const availableWorkers = deps.pool.all
      .filter((agent) => agent.id !== deps.pool.manager.id)
      .filter((agent) => !deps.executor.isOffSick(agent)).length;
    if (uniqueAgentCount < 2 && availableWorkers >= 2) {
      state.managerMemory.push(
        "Manager delegation invalid: immediate request asked for another agent, but assignments use only one agent.",
      );
      return false;
    }
  }

  const usageByAgent = new Map<string, number>();
  for (const assignment of assignments) {
    usageByAgent.set(
      assignment.agent.id,
      (usageByAgent.get(assignment.agent.id) ?? 0) + 1,
    );
  }
  const conflicting = assignments.find((assignment) =>
    assignment.instruction.config?.requiresDifferentAgent &&
      (usageByAgent.get(assignment.agent.id) ?? 0) > 1
  );
  if (conflicting) {
    state.managerMemory.push(
      "Manager delegation invalid: requiresDifferentAgent tasks must not share an agent in the same batch.",
    );
    return false;
  }

  const limited = assignments.slice(0, state.maxParallelWorkers);
  const correlationId = crypto.randomUUID();

  deps.events.append({
    type: "dispatch",
    count: limited.length,
    correlationId,
  });

  queueWorkerAssignments(c, state, limited, correlationId);
  return true;
}

function queueWorkerAssignments(
  c: { client: () => unknown },
  state: ManagerActorState,
  assignments: Array<{
    agent: AgentDefinition;
    instruction: NonNullable<ManagerDirective["delegations"]>[number];
    task: string;
  }>,
  correlationId: string,
): void {
  const deps = getRuntimeDependencies();
  const now = new Date().toISOString();
  const client = c.client() as unknown as ReturnType<ActorClientContext["client"]>;

  for (const assignment of assignments) {
    const taskId = crypto.randomUUID();
    const instruction = assignment.instruction;
    state.activeTasks.push({
      id: taskId,
      agentId: assignment.agent.id,
      agentName: assignment.agent.name,
      task: instruction.task,
      state: "running",
      startedAt: now,
    });

    const workerHandle = client.worker.getOrCreate([assignment.agent.id]);
    const envelope = createEnvelope({
      from: "manager_actor",
      to: "worker_actor",
      type: "worker.run_task",
      correlationId,
      content: {
        taskId,
        agentId: assignment.agent.id,
        task: instruction.task,
      },
    });

    deps.events.append({
      type: "actor_message",
      id: envelope.id,
      from: envelope.from,
      to: envelope.to,
      messageType: envelope.type,
      correlationId,
    });

    const runTaskInput = {
      taskId,
      agentId: assignment.agent.id,
      task: instruction.task,
      brief: buildWorkerBrief(state, instruction.task, instruction.brief),
      config: instruction.config,
      correlationId,
    };
    const delayMs = Math.max(
      0,
      Math.round(((instruction.config?.runAfterSeconds ?? 0) * 1000)),
    );

    void (async () => {
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      await workerHandle.runTask(runTaskInput);
    })().catch(async (error) => {
      const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
      await managerHandle.enqueueWorkerResult({
        taskId,
        correlationId,
        result: {
          agentId: assignment.agent.id,
          agentName: assignment.agent.name,
          task: instruction.task,
          output: `Worker dispatch failed: ${stringifyError(error)}`,
        },
      });
    });
  }
}

function runCouncilVote(c: { client: () => unknown }, state: ManagerActorState): void {
  const deps = getRuntimeDependencies();
  if (state.pendingCouncilVote) {
    return;
  }

  const correlationId = crypto.randomUUID();
  state.pendingCouncilVote = {
    correlationId,
    expected: deps.pool.council.length,
    received: [],
  };

  const available = deps.pool.council.filter((agent) => !deps.executor.isOffSick(agent));
  const unavailable = deps.pool.council.filter((agent) => deps.executor.isOffSick(agent));
  for (const agent of unavailable) {
    recordCouncilVote(state, {
      agentId: agent.id,
      agentName: agent.name,
      verdict: "incomplete",
      feedback: `Council member unavailable (off sick): ${
        deps.executor.getOffSickReason(agent) ?? "unknown"
      }`,
    }, correlationId);
  }

  const client = c.client() as unknown as ReturnType<ActorClientContext["client"]>;
  const workerOutputsSnapshot = state.workerOutputs.slice(-8);
  for (const agent of available) {
    const councilHandle = client.council.getOrCreate([agent.id]);

    const envelope = createEnvelope({
      from: "manager_actor",
      to: "council_actor",
      type: "council.vote",
      correlationId,
      content: { agentId: agent.id },
    });

    deps.events.append({
      type: "actor_message",
      id: envelope.id,
      from: envelope.from,
      to: envelope.to,
      messageType: envelope.type,
      correlationId,
    });

    void councilHandle.vote({
      agentId: agent.id,
      correlationId,
      objective: currentObjectiveContext(state),
      workerOutputs: workerOutputsSnapshot,
    }).catch(async (error) => {
      const managerHandle = client.manager.getOrCreate(MANAGER_ACTOR_KEY);
      await managerHandle.enqueueCouncilVote({
        correlationId,
        vote: {
          agentId: agent.id,
          agentName: agent.name,
          verdict: "incomplete",
          feedback: `Council dispatch failed: ${stringifyError(error)}`,
        },
      });
    });
  }
}

function structuredCouncilVote(
  agentId: string,
  agentName: string,
  decision: CouncilDecision,
): CouncilVote {
  return {
    agentId,
    agentName,
    verdict: decision.verdict,
    feedback: decision.feedback.trim() || "Council provided no feedback.",
  };
}

function recordCouncilVote(
  state: ManagerActorState,
  vote: CouncilVote,
  correlationId: string,
): void {
  const deps = getRuntimeDependencies();

  deps.events.append({
    type: "council_vote",
    agentId: vote.agentId,
    agentName: vote.agentName,
    verdict: vote.verdict,
    correlationId,
  });

  const pending = state.pendingCouncilVote;
  if (!pending || pending.correlationId !== correlationId) {
    return;
  }

  if (pending.received.some((entry) => entry.agentId === vote.agentId)) {
    return;
  }

  pending.received.push(vote);
  if (pending.received.length < pending.expected) {
    return;
  }

  state.pendingCouncilVote = null;
  const dissent = pending.received.filter((entry) => entry.verdict === "incomplete");
  if (dissent.length === 0 && pending.received.length === deps.pool.council.length) {
    state.completed = true;
    state.managerMemory.push("Council unanimous complete.");
    deps.events.append({
      type: "completion",
      complete: true,
      correlationId,
    });
    return;
  }

  state.completed = false;
  state.dissentFeedback = dissent;
  for (const entry of dissent) {
    state.managerMemory.push(`Council dissent (${entry.agentName}): ${entry.feedback}`);
  }
  deps.events.append({
    type: "completion",
    complete: false,
    correlationId,
  });
}

function buildManagerPrompt(
  state: ManagerActorState,
  requirements: { minDelegations: number; requireDifferentAgent: boolean },
): string {
  const deps = getRuntimeDependencies();
  const objectiveContext = currentObjectiveContext(state);

  const availableAgents = deps.pool.all
    .filter((agent) => agent.id !== deps.pool.manager.id)
    .map((agent) => {
      const availability = deps.executor.isOffSick(agent) ? "off_sick" : "available";
      const roleBits = [
        `name=${agent.name}`,
        `council=${agent.council}`,
        `useMe=${agent.useMe}`,
        `availability=${availability}`,
      ];
      return `- ${roleBits.join(" | ")}`;
    })
    .join("\n");

  const recentWorker = state.workerOutputs.slice(-6).map((item) =>
    `- ${item.agentName} on \"${item.task}\": ${truncate(item.output, 1200)}`
  ).join("\n");
  const activeDelegations = state.activeTasks.slice(-12).map((task) =>
    `- ${task.agentName} on \"${task.task}\" (started ${task.startedAt})`
  ).join("\n");
  const councilStatus = state.pendingCouncilVote
    ? `- in progress (${state.pendingCouncilVote.received.length}/${state.pendingCouncilVote.expected})`
    : "- idle";
  const recentDissent = state.dissentFeedback.slice(-6).map((item) =>
    `- ${item.agentName}: ${truncate(item.feedback, 1200)}`
  ).join("\n");
  const pendingUser = state.pendingUserMessages.slice(0, 6).map((item) => `- ${item.text}`).join(
    "\n",
  );
  const memory = state.managerMemory.slice(-12).map((line) => `- ${truncate(line, 1200)}`).join(
    "\n",
  );

  return [
    `You are the manager agent for rawko.`,
    `You must not do direct implementation work. You only coordinate delegates and council votes.`,
    `Objective: ${objectiveContext}`,
    `Cycle: ${state.cycle}`,
    `Objective completed so far: ${state.completed}`,
    "",
    "Available agents:",
    availableAgents || "- (none)",
    "",
    "Active delegations in flight:",
    activeDelegations || "- (none)",
    "",
    "Pending user messages:",
    pendingUser || "- (none)",
    "",
    "Recent worker outputs:",
    recentWorker || "- (none)",
    "",
    "Council vote status:",
    councilStatus,
    "",
    "Recent council dissent (only incomplete feedback):",
    recentDissent || "- (none)",
    "",
    "Recent manager memory:",
    memory || "- (none)",
    "",
    `Immediate request decomposition expects at least ${requirements.minDelegations} delegated job(s).`,
    requirements.requireDifferentAgent
      ? "Immediate request explicitly asks for another/different agent."
      : "Immediate request does not explicitly require another/different agent.",
    "",
    "Decide your next orchestration action based on context.",
    "Available actions:",
    "- delegate: assign concrete scoped tasks to one or more workers.",
    "- council_vote: request completion review from council members.",
    "- reply_user: send a status/progress reply to the user.",
    "- await_user: ask the user for clarifying input or decisions.",
    "- wait: pause briefly when no concrete action is possible.",
    `For mode=delegate, pick at most ${state.maxParallelWorkers} delegates.`,
    "For mode=delegate, each entry in delegations should be one concrete job.",
    "If user asks multiple things, emit multiple delegation entries in one response.",
    `For this turn, if you choose mode=delegate you must emit at least ${requirements.minDelegations} delegation entries.`,
    requirements.requireDifferentAgent
      ? "For this turn, delegate to at least two distinct agents when feasible."
      : "Distinct-agent delegation is optional for this turn.",
    "For each delegation, include brief for minimal context when needed.",
    "Optional config per delegation: runAfterSeconds, maxRuntimeSeconds, requiresDifferentAgent.",
    "If active delegations already cover the request, avoid duplicate delegations and prefer reply_user or wait.",
    "Each pending user message can be a separate objective; multiple objectives may be in flight at once.",
    "If pending user messages are present, do not ask the user for their objective again.",
    "Treat the oldest pending user message as the immediate instruction to act on.",
    "If pending user messages are present, do not choose wait unless you cannot take any concrete action.",
    "For execution-style requests (for example shell commands), prefer delegate with a concrete scoped task.",
    "Use LLM judgment on each agent's useMe field.",
    "Use council_vote only when you think objective is complete.",
    "Use await_user when you need the user's next input before proceeding.",
    "Use reply_user when providing a mid-workflow status update and you want to continue planning immediately.",
    "For user-facing replies, do not mention council or internal voting unless explicitly asked.",
  ].join("\n");
}

function buildWorkerPrompt(input: {
  task: string;
  brief: string;
  config?: {
    runAfterSeconds?: number;
    maxRuntimeSeconds?: number;
    requiresDifferentAgent?: boolean;
  };
}): string {
  const brief = input.brief.trim();
  const configBits: string[] = [];
  if (input.config?.runAfterSeconds !== undefined) {
    configBits.push(`runAfterSeconds=${input.config.runAfterSeconds}`);
  }
  if (input.config?.maxRuntimeSeconds !== undefined) {
    configBits.push(`maxRuntimeSeconds=${input.config.maxRuntimeSeconds}`);
  }
  if (input.config?.requiresDifferentAgent !== undefined) {
    configBits.push(`requiresDifferentAgent=${input.config.requiresDifferentAgent}`);
  }
  return [
    `Your delegated task: ${input.task}`,
    brief ? `Minimal context: ${brief}` : "Minimal context: (none)",
    configBits.length > 0 ? `Task config: ${configBits.join(", ")}` : "Task config: (none)",
    "",
    "Return free-form coworker-style output that includes:",
    "- Is this delegated task complete?",
    "- Outstanding tasks",
    "- Questions",
    "- Next steps",
  ].join("\n");
}

function buildWorkerBrief(
  state: ManagerActorState,
  delegatedTask: string,
  explicitBrief?: string,
): string {
  const normalizedExplicit = (explicitBrief ?? "").trim();
  if (normalizedExplicit) {
    return truncate(normalizedExplicit, 220);
  }

  const objective = currentObjectiveContext(state);
  if (!objective || objective === "(none)") {
    return "";
  }

  const normalizedObjective = objective.trim();
  if (!normalizedObjective) {
    return "";
  }

  const normalizedTask = delegatedTask.trim().toLowerCase();
  const normalizedObjectiveLower = normalizedObjective.toLowerCase();
  if (normalizedTask && normalizedTask.includes(normalizedObjectiveLower)) {
    return "";
  }

  return truncate(normalizedObjective, 220);
}

function buildCouncilPrompt(
  objective: string,
  workerOutputs: Array<{ agentName: string; task: string; output: string }>,
): string {
  const recent = workerOutputs.slice(-8).map((item) =>
    `- ${item.agentName} / ${item.task}: ${truncate(item.output, 1200)}`
  ).join("\n");

  return [
    `Evaluate whether the objective is complete.`,
    `Objective: ${objective}`,
    "",
    "Recent worker outcomes:",
    recent || "- (none)",
    "",
    "Provide a decisive review with evidence from worker outcomes.",
    "If incomplete, call out specific remaining gaps and risks.",
  ].join("\n");
}

function buildWorkerResultChatMessage(result: WorkerResult): string {
  const task = result.task.trim() || "delegated task";
  const output = result.output.trim() || "(no output)";
  return [
    `Worker update: ${result.agentName} completed "${task}".`,
    "",
    truncate(output, 2400),
  ].join("\n");
}

function truncateStateMemory(state: ManagerActorState): void {
  state.managerMemory = state.managerMemory.slice(-80);
  state.pendingUserMessages = state.pendingUserMessages.slice(-20);
  state.workerOutputs = state.workerOutputs.slice(-60);
  state.dissentFeedback = state.dissentFeedback.slice(-20);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function invokeWorkerWithOptionalTimeout(
  invoke: () => Promise<string>,
  maxRuntimeSeconds?: number,
): Promise<string> {
  const timeoutSeconds = Number.isFinite(maxRuntimeSeconds ?? NaN)
    ? Math.max(1, Math.floor(maxRuntimeSeconds as number))
    : 0;
  if (timeoutSeconds <= 0) {
    return await invoke();
  }

  let timer: number | null = null;
  try {
    return await Promise.race([
      invoke(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Worker runtime exceeded ${timeoutSeconds}s`)),
          timeoutSeconds * 1000,
        );
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}
