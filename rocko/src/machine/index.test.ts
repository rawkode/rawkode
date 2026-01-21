import { test, expect, describe } from "bun:test";
import { createActor } from "xstate";
import { rockoMachine } from "./index.ts";
import type { PlanOutput, BuildOutput, ReviewIssue } from "./types.ts";

describe("rockoMachine", () => {
  test("starts in plan state", () => {
    const actor = createActor(rockoMachine);
    actor.start();

    expect(actor.getSnapshot().matches("plan")).toBe(true);
    expect(actor.getSnapshot().context.currentPhase).toBe("plan");
    expect(actor.getSnapshot().context.iteration).toBe(1);

    actor.stop();
  });

  test("transitions to end on NOTHING_TO_DO", () => {
    const actor = createActor(rockoMachine);
    actor.start();

    actor.send({ type: "NOTHING_TO_DO" });

    expect(actor.getSnapshot().matches("end")).toBe(true);
    expect(actor.getSnapshot().context.currentPhase).toBe("end");

    actor.stop();
  });

  test("transitions through full workflow", () => {
    const actor = createActor(rockoMachine, {
      input: { maxIterations: 1 },
    });
    actor.start();

    const plan: PlanOutput = {
      task: {
        id: "task-1",
        title: "Test Task",
        description: "A test task",
        source: "test",
      },
      approach: "Test approach",
      steps: [{ description: "Step 1", files: ["file.ts"] }],
      estimatedComplexity: "low",
    };

    actor.send({ type: "START_BUILD", plan });
    expect(actor.getSnapshot().matches("build")).toBe(true);
    expect(actor.getSnapshot().context.plan).toEqual(plan);

    const buildOutput: BuildOutput = {
      filesChanged: ["file.ts"],
      summary: "Changed file.ts",
      testsRun: true,
      testsPassed: true,
    };

    actor.send({ type: "IMPLEMENTATION_DONE", output: buildOutput });
    expect(actor.getSnapshot().matches("review")).toBe(true);
    expect(actor.getSnapshot().context.build).toEqual(buildOutput);

    actor.send({ type: "APPROVED" });
    expect(actor.getSnapshot().matches("commit")).toBe(true);

    actor.send({ type: "COMMITTED", message: "test commit" });
    expect(actor.getSnapshot().matches("end")).toBe(true);

    actor.stop();
  });

  test("loops back to build on NEEDS_FIXES", () => {
    const actor = createActor(rockoMachine);
    actor.start();

    const plan: PlanOutput = {
      task: {
        id: "task-1",
        title: "Test Task",
        description: "A test task",
        source: "test",
      },
      approach: "Test approach",
      steps: [{ description: "Step 1", files: ["file.ts"] }],
      estimatedComplexity: "low",
    };

    actor.send({ type: "START_BUILD", plan });
    actor.send({
      type: "IMPLEMENTATION_DONE",
      output: {
        filesChanged: ["file.ts"],
        summary: "Changed file.ts",
        testsRun: true,
        testsPassed: true,
      },
    });

    const issues: ReviewIssue[] = [
      {
        severity: "error",
        file: "file.ts",
        line: 10,
        message: "Bug found",
      },
    ];

    actor.send({ type: "NEEDS_FIXES", issues });
    expect(actor.getSnapshot().matches("build")).toBe(true);
    expect(actor.getSnapshot().context.review?.approved).toBe(false);

    actor.stop();
  });

  test("loops back to plan on BLOCKED", () => {
    const actor = createActor(rockoMachine);
    actor.start();

    const plan: PlanOutput = {
      task: {
        id: "task-1",
        title: "Test Task",
        description: "A test task",
        source: "test",
      },
      approach: "Test approach",
      steps: [{ description: "Step 1", files: ["file.ts"] }],
      estimatedComplexity: "low",
    };

    actor.send({ type: "START_BUILD", plan });
    expect(actor.getSnapshot().matches("build")).toBe(true);

    actor.send({ type: "BLOCKED", reason: "Cannot proceed" });
    expect(actor.getSnapshot().matches("plan")).toBe(true);
    expect(actor.getSnapshot().context.error).toBe("Cannot proceed");

    actor.stop();
  });

  test("supports multiple iterations", () => {
    const actor = createActor(rockoMachine, {
      input: { maxIterations: 3 },
    });
    actor.start();

    const makeIteration = (iteration: number) => {
      const plan: PlanOutput = {
        task: {
          id: `task-${iteration}`,
          title: `Task ${iteration}`,
          description: "A test task",
          source: "test",
        },
        approach: "Test approach",
        steps: [{ description: "Step 1", files: ["file.ts"] }],
        estimatedComplexity: "low",
      };

      actor.send({ type: "START_BUILD", plan });
      actor.send({
        type: "IMPLEMENTATION_DONE",
        output: {
          filesChanged: ["file.ts"],
          summary: "Changed file.ts",
          testsRun: true,
          testsPassed: true,
        },
      });
      actor.send({ type: "APPROVED" });
    };

    makeIteration(1);
    expect(actor.getSnapshot().matches("commit")).toBe(true);
    expect(actor.getSnapshot().context.iteration).toBe(1);

    actor.send({ type: "NEXT_ITERATION" });
    expect(actor.getSnapshot().matches("plan")).toBe(true);
    expect(actor.getSnapshot().context.iteration).toBe(2);

    makeIteration(2);
    actor.send({ type: "NEXT_ITERATION" });
    expect(actor.getSnapshot().context.iteration).toBe(3);

    makeIteration(3);
    actor.send({ type: "COMMITTED", message: "final commit" });
    expect(actor.getSnapshot().matches("end")).toBe(true);

    actor.stop();
  });

  test("records history", () => {
    const actor = createActor(rockoMachine);
    actor.start();

    const plan: PlanOutput = {
      task: {
        id: "task-1",
        title: "Test Task",
        description: "A test task",
        source: "test",
      },
      approach: "Test approach",
      steps: [],
      estimatedComplexity: "low",
    };

    actor.send({ type: "START_BUILD", plan });

    const history = actor.getSnapshot().context.history;
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((h) => h.event === "START_BUILD")).toBe(true);

    actor.stop();
  });
});
