import type { FlueContext, WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import { secureMiniAppResponse } from "../lib/cloudflare-dispatch";
import { requireHostSigningSecret, signHostContext } from "../lib/host-context";
import { miniAppWorkflowRoutePath } from "../lib/mini-app-workflows";
import { createAuditRecord, getExtension } from "../lib/repository";
import type { Env, JsonObject, RegisteredExtension } from "../lib/types";

export const route: WorkflowRouteHandler = async (_c, next) => next();

const scheduledMiniAppWorkflowPayloadSchema = v.object({
	extensionSlug: v.string(),
	workflowId: v.string(),
	scheduledWorkflow: v.object({
		id: v.string(),
		scheduledAt: v.string(),
	}),
});

type ScheduledMiniAppWorkflowPayload = v.InferOutput<typeof scheduledMiniAppWorkflowPayloadSchema>;

export async function run({ env, payload }: FlueContext<JsonObject, Env>) {
	const parsed = v.safeParse(scheduledMiniAppWorkflowPayloadSchema, payload);
	if (!parsed.success) {
		throw new Error("Scheduled mini-app workflow payload is invalid.");
	}

	try {
		const result = await dispatchScheduledMiniAppWorkflow(env, parsed.output, payload);
		await createAuditRecord(env, {
			slug: parsed.output.extensionSlug,
			action: "mini-app-workflow",
			status: "completed",
			details: result as unknown as JsonObject,
		});
		return result;
	} catch (error) {
		const message = errorMessage(error);
		await createAuditRecord(env, {
			slug: parsed.output.extensionSlug,
			action: "mini-app-workflow",
			status: "failed",
			details: {
				error: message,
				scheduledAt: parsed.output.scheduledWorkflow.scheduledAt,
				scheduledWorkflowId: parsed.output.scheduledWorkflow.id,
				workflowId: parsed.output.workflowId,
			},
		});
		throw new Error(message);
	}
}

async function dispatchScheduledMiniAppWorkflow(
	env: Env,
	parsed: ScheduledMiniAppWorkflowPayload,
	payload: JsonObject,
): Promise<JsonObject> {
	const extension = await getExtension(env, parsed.extensionSlug);
	if (!extension) {
		throw new Error(`Mini app ${parsed.extensionSlug} is not registered.`);
	}
	if (extension.status === "disabled") {
		throw new Error(`Mini app ${parsed.extensionSlug} is disabled.`);
	}
	if (!extension.deployedScriptName) {
		throw new Error(`Mini app ${parsed.extensionSlug} has no deployed Worker.`);
	}
	if (!env.MINI_APP_DISPATCHER) {
		throw new Error("Dispatch namespace binding is not configured.");
	}

	const callbackPath = miniAppWorkflowRoutePath(extension.slug, parsed.workflowId);
	if (!isDeclaredWorkflowCallbackRoute(extension, callbackPath)) {
		throw new Error(`Mini app ${extension.slug} does not declare workflow callback route ${callbackPath}.`);
	}

	const token = extension.hostApis.length > 0
		? await signHostContext({
			app: extension.slug,
			scopes: extension.hostApis,
			expiresAt: Date.now() + 5 * 60 * 1000,
			context: {
				path: callbackPath,
				scheduledAt: parsed.scheduledWorkflow.scheduledAt,
				workflowId: parsed.workflowId,
			},
		}, requireHostSigningSecret(env))
		: undefined;

	const response = await env.MINI_APP_DISPATCHER.get(extension.deployedScriptName).fetch(new Request(
		new URL(callbackPath, "https://scheduler.enchiridion.local"),
		{
			method: "POST",
			headers: createWorkflowCallbackHeaders(token),
			body: JSON.stringify(payload),
		},
	));
	const safeResponse = await secureMiniAppResponse({
		response,
		slug: extension.slug,
		requestUrl: `https://scheduler.enchiridion.local${callbackPath}`,
		hostContextToken: token,
	});
	const body = await safeResponse.text();

	if (!safeResponse.ok) {
		throw new Error(`Mini app workflow callback failed with ${safeResponse.status}: ${body.slice(0, 500)}`);
	}

	return {
		callbackPath,
		contentType: safeResponse.headers.get("content-type"),
		responseBody: body.slice(0, 2_000),
		responseStatus: safeResponse.status,
		scheduledAt: parsed.scheduledWorkflow.scheduledAt,
		scheduledWorkflowId: parsed.scheduledWorkflow.id,
		workflowId: parsed.workflowId,
	};
}

function createWorkflowCallbackHeaders(hostContextToken?: string): Headers {
	const headers = new Headers({
		accept: "application/json,text/plain,text/html;q=0.7,*/*;q=0.5",
		"content-type": "application/json",
	});
	if (hostContextToken) {
		headers.set("x-enchiridion-host-context", hostContextToken);
	}
	return headers;
}

function isDeclaredWorkflowCallbackRoute(extension: RegisteredExtension, callbackPath: string): boolean {
	return extension.routes.some((route) =>
		route.path === callbackPath
		&& route.mode === "worker-fragment"
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	return "Mini app workflow failed.";
}
