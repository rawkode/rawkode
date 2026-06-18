import app from "./app";
import { requireHostSigningSecret, signSchedulerWorkflowRequest } from "./lib/host-context";
import { dispatchMiniAppBuildAttempt } from "./lib/mini-app-builds";
import { createAuditRecord, failMiniAppBuild, listRecoverableMiniAppBuilds } from "./lib/repository";
import { runDueScheduledWorkflows, type ScheduledWorkflowInvocation } from "./lib/scheduled-workflows";
import type { Env, JsonObject, MiniAppBuild, ScheduledWorkflow } from "./lib/types";

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const scheduledTime = new Date(controller.scheduledTime);
		ctx.waitUntil(Promise.all([
			runDueScheduledWorkflows(env, {
				scheduledTime,
				invokeWorkflow: (workflow, payload, scheduledAt) => invokeMountedFlueWorkflow(env, ctx, workflow, payload, scheduledAt),
			}),
			retryInterruptedMiniAppBuilds(env, ctx, scheduledTime),
		]));
	},
};

async function retryInterruptedMiniAppBuilds(env: Env, _ctx: ExecutionContext, scheduledTime: Date): Promise<void> {
	const builds = await listRecoverableMiniAppBuilds(env, scheduledTime.toISOString());
	for (const build of builds) {
		await retryInterruptedMiniAppBuild(env, build);
	}
}

async function retryInterruptedMiniAppBuild(
	env: Env,
	build: MiniAppBuild,
): Promise<void> {
	const nextAttempt = build.attemptCount + 1;
	try {
		await dispatchMiniAppBuildAttempt(env, build, nextAttempt);
	} catch (error) {
		if (nextAttempt >= build.maxAttempts) {
			await failMiniAppBuild(env, {
				id: build.id,
				status: "failed",
				error: {
					message: errorMessage(error),
					attempt: nextAttempt,
				},
			});
		}
		await createAuditRecord(env, {
			slug: build.targetSlug ?? build.slugHint ?? "agent",
			action: `${build.operation}-mini-app`,
			status: "build_retry_failed",
			details: {
				buildId: build.id,
				attempt: nextAttempt,
				error: errorMessage(error),
			},
		});
	}
}

async function invokeMountedFlueWorkflow(
	env: Env,
	ctx: ExecutionContext,
	workflow: ScheduledWorkflow,
	payload: JsonObject,
	scheduledAt: string,
): Promise<ScheduledWorkflowInvocation> {
	const path = `/api/flue/workflows/${encodeURIComponent(workflow.workflowName)}`;
	const token = await signSchedulerWorkflowRequest({
		path,
		scheduledAt,
		secret: requireHostSigningSecret(env),
	});
	const response = await app.fetch(new Request(`https://scheduler.enchiridion.local${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-enchiridion-scheduler": token,
		},
		body: JSON.stringify(payload),
	}), env, ctx);
	const body = await readJsonBody<{
		error?: unknown;
		offset?: string;
		runId?: string;
		streamUrl?: string;
	}>(response);

	if (!response.ok) {
		throw new Error(formatWorkflowInvocationError(workflow, body.error, response.status));
	}

	return {
		payload,
		runId: body.runId,
		streamUrl: body.streamUrl,
		workflowName: workflow.workflowName,
	};
}

async function readJsonBody<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!text) {
		return {} as T;
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return { error: text } as T;
	}
}

function formatWorkflowInvocationError(workflow: ScheduledWorkflow, error: unknown, status: number): string {
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return `Scheduled workflow ${workflow.workflowName} failed with ${status}.`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return "An internal error occurred.";
}
