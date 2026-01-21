import { createMachine, assign } from "xstate";
import type {
  MachineContext,
  MachineEvent,
  Phase,
  PlanOutput,
  BuildOutput,
  ReviewOutput,
  CommitOutput,
} from "./types.ts";

export const rockoMachine = createMachine({
  id: "rocko",
  types: {} as {
    context: MachineContext;
    events: MachineEvent;
  },
  initial: "plan",
  context: ({ input }: { input?: Partial<MachineContext> }) => ({
    iteration: input?.iteration ?? 1,
    maxIterations: input?.maxIterations ?? 5,
    currentPhase: "plan" as Phase,
    history: input?.history ?? [],
    task: input?.task,
    plan: input?.plan,
    build: input?.build,
    review: input?.review,
    commit: input?.commit,
    error: input?.error,
  }),
  states: {
    plan: {
      entry: assign({
        currentPhase: "plan" as Phase,
        history: ({ context }) => [
          ...context.history,
          { phase: "plan" as Phase, timestamp: new Date(), event: "entered" },
        ],
      }),
      on: {
        START_BUILD: {
          target: "build",
          actions: assign({
            plan: ({ event }) => event.plan,
            task: ({ event }) => event.plan.task,
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "plan" as Phase,
                timestamp: new Date(),
                event: "START_BUILD",
                data: { taskId: event.plan.task.id },
              },
            ],
          }),
        },
        NOTHING_TO_DO: {
          target: "end",
          actions: assign({
            history: ({ context }) => [
              ...context.history,
              {
                phase: "plan" as Phase,
                timestamp: new Date(),
                event: "NOTHING_TO_DO",
              },
            ],
          }),
        },
      },
    },
    build: {
      entry: assign({
        currentPhase: "build" as Phase,
        history: ({ context }) => [
          ...context.history,
          { phase: "build" as Phase, timestamp: new Date(), event: "entered" },
        ],
      }),
      on: {
        IMPLEMENTATION_DONE: {
          target: "review",
          actions: assign({
            build: ({ event }) => event.output,
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "build" as Phase,
                timestamp: new Date(),
                event: "IMPLEMENTATION_DONE",
                data: { filesChanged: event.output.filesChanged.length },
              },
            ],
          }),
        },
        BLOCKED: {
          target: "plan",
          actions: assign({
            error: ({ event }) => event.reason,
            plan: undefined,
            build: undefined,
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "build" as Phase,
                timestamp: new Date(),
                event: "BLOCKED",
                data: { reason: event.reason },
              },
            ],
          }),
        },
      },
    },
    review: {
      entry: assign({
        currentPhase: "review" as Phase,
        history: ({ context }) => [
          ...context.history,
          { phase: "review" as Phase, timestamp: new Date(), event: "entered" },
        ],
      }),
      on: {
        NEEDS_FIXES: {
          target: "build",
          actions: assign({
            review: ({ event }) => ({
              approved: false,
              issues: event.issues,
              summary: `Found ${event.issues.length} issue(s) that need fixing`,
            }),
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "review" as Phase,
                timestamp: new Date(),
                event: "NEEDS_FIXES",
                data: { issueCount: event.issues.length },
              },
            ],
          }),
        },
        APPROVED: {
          target: "commit",
          actions: assign({
            review: ({ context }) => ({
              approved: true,
              issues: context.review?.issues ?? [],
              summary: "Changes approved",
            }),
            history: ({ context }) => [
              ...context.history,
              {
                phase: "review" as Phase,
                timestamp: new Date(),
                event: "APPROVED",
              },
            ],
          }),
        },
      },
    },
    commit: {
      entry: assign({
        currentPhase: "commit" as Phase,
        history: ({ context }) => [
          ...context.history,
          { phase: "commit" as Phase, timestamp: new Date(), event: "entered" },
        ],
      }),
      on: {
        COMMITTED: {
          target: "end",
          actions: assign({
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "commit" as Phase,
                timestamp: new Date(),
                event: "COMMITTED",
                data: { message: event.message },
              },
            ],
          }),
          guard: ({ context }) => context.iteration >= context.maxIterations,
        },
        NEXT_ITERATION: {
          target: "plan",
          actions: assign({
            iteration: ({ context }) => context.iteration + 1,
            plan: undefined,
            build: undefined,
            review: undefined,
            commit: undefined,
            error: undefined,
            history: ({ context }) => [
              ...context.history,
              {
                phase: "commit" as Phase,
                timestamp: new Date(),
                event: "NEXT_ITERATION",
                data: { nextIteration: context.iteration + 1 },
              },
            ],
          }),
          guard: ({ context }) => context.iteration < context.maxIterations,
        },
        COMMIT_FAILED: {
          target: "review",
          actions: assign({
            error: ({ event }) => event.reason,
            history: ({ context, event }) => [
              ...context.history,
              {
                phase: "commit" as Phase,
                timestamp: new Date(),
                event: "COMMIT_FAILED",
                data: { reason: event.reason },
              },
            ],
          }),
        },
      },
    },
    end: {
      type: "final",
      entry: assign({
        currentPhase: "end" as Phase,
        history: ({ context }) => [
          ...context.history,
          { phase: "end" as Phase, timestamp: new Date(), event: "completed" },
        ],
      }),
    },
  },
});

export type RockoMachine = typeof rockoMachine;
export * from "./types.ts";
export * from "./schemas.ts";
