import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledWorkflow } from "../src/lib/types";

const mockState = vi.hoisted(() => ({
	audits: [] as Array<Record<string, unknown>>,
	attempts: [] as Array<{ attemptedAt: string; id: string }>,
	workflows: [] as ScheduledWorkflow[],
}));

vi.mock("../src/lib/repository", () => ({
	createAuditRecord: vi.fn(async (_env: Env, record: Record<string, unknown>) => {
		mockState.audits.push(record);
	}),
	listEnabledScheduledWorkflows: vi.fn(async () => mockState.workflows),
	recordScheduledWorkflowAttempt: vi.fn(async (_env: Env, id: string, attemptedAt: string) => {
		mockState.attempts.push({ id, attemptedAt });
	}),
}));

const baseWorkflow: ScheduledWorkflow = {
	id: "rss-reader:refresh-feeds",
	extensionSlug: "rss-reader",
	name: "RSS Reader: Refresh feeds",
	cron: "*/5 * * * *",
	workflowName: "run-mini-app-workflow",
	payload: { app: "rss-reader" },
	enabled: true,
	lastRunAt: null,
	createdAt: "2026-06-18T00:00:00.000Z",
	updatedAt: "2026-06-18T00:00:00.000Z",
};

describe("scheduled workflow runner", () => {
	beforeEach(() => {
		mockState.audits.length = 0;
		mockState.attempts.length = 0;
		mockState.workflows.length = 0;
		vi.clearAllMocks();
	});

	it("admits due workflows and records audit details", async () => {
		const { runDueScheduledWorkflows } = await import("../src/lib/scheduled-workflows");
		mockState.workflows.push(baseWorkflow);

		const result = await runDueScheduledWorkflows({} as Env, {
			scheduledTime: new Date("2026-06-18T12:10:00.000Z"),
			invokeWorkflow: async (_workflow, payload) => ({
				payload,
				runId: "run-123",
				streamUrl: "/api/flue/runs/run-123",
				workflowName: "run-mini-app-workflow",
			}),
		});

		expect(result).toEqual([{
			id: "rss-reader:refresh-feeds",
			runId: "run-123",
			status: "admitted",
			workflowName: "run-mini-app-workflow",
		}]);
		expect(mockState.attempts).toEqual([{
			id: "rss-reader:refresh-feeds",
			attemptedAt: "2026-06-18T12:10:00.000Z",
		}]);
		expect(mockState.audits).toEqual([expect.objectContaining({
			action: "scheduled-workflow",
			slug: "rss-reader",
			status: "admitted",
			details: expect.objectContaining({
				cron: "*/5 * * * *",
				runId: "run-123",
				scheduledAt: "2026-06-18T12:10:00.000Z",
				workflowId: "rss-reader:refresh-feeds",
				workflowName: "run-mini-app-workflow",
			}),
		})]);
	});

	it("skips workflows already attempted in the same UTC minute", async () => {
		const { runDueScheduledWorkflows } = await import("../src/lib/scheduled-workflows");
		mockState.workflows.push({
			...baseWorkflow,
			lastRunAt: "2026-06-18T12:10:22.000Z",
		});

		const result = await runDueScheduledWorkflows({} as Env, {
			scheduledTime: new Date("2026-06-18T12:10:00.000Z"),
			invokeWorkflow: async () => {
				throw new Error("should not run");
			},
		});

		expect(result).toEqual([]);
		expect(mockState.attempts).toEqual([]);
		expect(mockState.audits).toEqual([]);
	});

	it("records failed admissions without retrying inside the same scheduled tick", async () => {
		const { runDueScheduledWorkflows } = await import("../src/lib/scheduled-workflows");
		mockState.workflows.push(baseWorkflow);

		const result = await runDueScheduledWorkflows({} as Env, {
			scheduledTime: new Date("2026-06-18T12:10:00.000Z"),
			invokeWorkflow: async () => {
				throw new Error("Workflow route not found");
			},
		});

		expect(result).toEqual([{
			error: "Workflow route not found",
			id: "rss-reader:refresh-feeds",
			status: "failed",
			workflowName: "run-mini-app-workflow",
		}]);
		expect(mockState.attempts).toHaveLength(1);
		expect(mockState.audits).toEqual([expect.objectContaining({
			action: "scheduled-workflow",
			slug: "rss-reader",
			status: "failed",
			details: expect.objectContaining({
				error: "Workflow route not found",
			}),
		})]);
	});
});
