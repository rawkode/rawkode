import { cronMatches } from "./cron";
import {
	createAuditRecord,
	listEnabledScheduledWorkflows,
	recordScheduledWorkflowAttempt,
} from "./repository";
import type { Env, JsonObject, ScheduledWorkflow } from "./types";

export interface ScheduledWorkflowInvocation {
	payload: JsonObject;
	runId?: string;
	streamUrl?: string;
	workflowName: string;
}

export interface ScheduledWorkflowRunResult {
	error?: string;
	id: string;
	runId?: string;
	status: "admitted" | "failed" | "skipped";
	workflowName: string;
}

export type ScheduledWorkflowInvoker = (
	workflow: ScheduledWorkflow,
	payload: JsonObject,
	scheduledAt: string,
) => Promise<ScheduledWorkflowInvocation>;

export async function runDueScheduledWorkflows(
	env: Env,
	input: {
		invokeWorkflow: ScheduledWorkflowInvoker;
		scheduledTime: Date;
	},
): Promise<ScheduledWorkflowRunResult[]> {
	const scheduledAt = input.scheduledTime.toISOString();
	const workflows = await listEnabledScheduledWorkflows(env);
	const due = workflows.filter((workflow) => isScheduledWorkflowDue(workflow, input.scheduledTime));
	const results: ScheduledWorkflowRunResult[] = [];

	for (const workflow of due) {
		await recordScheduledWorkflowAttempt(env, workflow.id, scheduledAt);
		const payload = scheduledWorkflowInvocationPayload(workflow, scheduledAt);

		try {
			const invocation = await input.invokeWorkflow(workflow, payload, scheduledAt);
			await createAuditRecord(env, {
				slug: workflow.extensionSlug ?? "system",
				action: "scheduled-workflow",
				status: "admitted",
				details: {
					cron: workflow.cron,
					runId: invocation.runId,
					scheduledAt,
					streamUrl: invocation.streamUrl,
					workflowId: workflow.id,
					workflowName: workflow.workflowName,
				},
			});
			results.push({
				id: workflow.id,
				runId: invocation.runId,
				status: "admitted",
				workflowName: workflow.workflowName,
			});
		} catch (error) {
			const message = errorMessage(error);
			await createAuditRecord(env, {
				slug: workflow.extensionSlug ?? "system",
				action: "scheduled-workflow",
				status: "failed",
				details: {
					cron: workflow.cron,
					error: message,
					scheduledAt,
					workflowId: workflow.id,
					workflowName: workflow.workflowName,
				},
			});
			results.push({
				error: message,
				id: workflow.id,
				status: "failed",
				workflowName: workflow.workflowName,
			});
		}
	}

	return results;
}

export function isScheduledWorkflowDue(workflow: ScheduledWorkflow, scheduledTime: Date): boolean {
	if (!workflow.enabled || !cronMatches(workflow.cron, scheduledTime)) {
		return false;
	}

	return !workflow.lastRunAt || !sameUtcMinute(new Date(workflow.lastRunAt), scheduledTime);
}

function scheduledWorkflowInvocationPayload(workflow: ScheduledWorkflow, scheduledAt: string): JsonObject {
	return {
		...workflow.payload,
		scheduledWorkflow: {
			cron: workflow.cron,
			extensionSlug: workflow.extensionSlug,
			id: workflow.id,
			name: workflow.name,
			scheduledAt,
			workflowName: workflow.workflowName,
		},
	};
}

function sameUtcMinute(left: Date, right: Date): boolean {
	return Number.isFinite(left.getTime())
		&& left.getUTCFullYear() === right.getUTCFullYear()
		&& left.getUTCMonth() === right.getUTCMonth()
		&& left.getUTCDate() === right.getUTCDate()
		&& left.getUTCHours() === right.getUTCHours()
		&& left.getUTCMinutes() === right.getUTCMinutes();
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	return "Scheduled workflow failed.";
}
