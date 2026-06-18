import { createAgent, defineTool } from "@flue/runtime";
import * as v from "valibot";
import { registerRuntimeProviders } from "../lib/flue-providers";
import { errorMessage } from "../lib/mini-app-builds";
import {
	completeMiniAppBuild,
	createAuditRecord,
	failMiniAppBuild,
	getMiniAppBuild,
} from "../lib/repository";
import type { Env, JsonObject, MiniAppBuild } from "../lib/types";
import {
	deployGeneratedMiniAppCandidate,
	generatedMiniAppSchema,
	miniAppBuildSucceeded,
	type GenerateMiniAppPayload,
	type GeneratedMiniApp,
} from "../workflows/generate-mini-app";

export const description = "Durable mini-app builder for Enchiridion dynamic Worker extensions.";

export default createAgent<unknown, Env>(({ env, id }) => {
	registerRuntimeProviders(env);

	return {
		model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
		durability: {
			maxAttempts: 6,
			timeoutMs: 30 * 60 * 1000,
		},
		instructions: [
			"You are Enchiridion's durable mini-app builder.",
			"You receive a dispatch_input JSON payload containing buildId, prompt, operation, targetSlug, slugHint, autonomousDeploy, buildAttempt, and buildDeadlineAt.",
			"Generate exactly one complete Enchiridion mini-app candidate and call submit_mini_app_candidate with it.",
			"Do not claim a mini app is deployed from chat text. The submit_mini_app_candidate tool validates the manifest, uploads the Cloudflare dispatch Worker, smoke tests it, saves the extension, and settles the build ledger.",
			"If the request needs recurring work, declare scheduled manifest workflows and worker-owned callback routes under /apps/<slug>/_workflows/*. The Enchiridion host owns cron scheduling; generated Workers must not rely on Cloudflare Cron Triggers inside the dispatch namespace.",
			"Routes must stay under /apps/<slug>. Generated Workers must be self-contained module Workers and must not import packages or access the host D1 binding.",
			"Use scoped host APIs only when declared in the manifest. Prefer worker-page routes plus host scheduler workflows for mini apps that need background syncing.",
			"If you cannot produce a safe candidate, call fail_mini_app_build with the concrete reason.",
		].join(" "),
		tools: [
			submitMiniAppCandidateTool(env, id),
			failMiniAppBuildTool(env, id),
		],
	};
});

function submitMiniAppCandidateTool(env: Env, buildId: string) {
	return defineTool({
		name: "submit_mini_app_candidate",
		description: "Validate, deploy, smoke test, register, and settle one generated Enchiridion mini-app candidate for the current build.",
		parameters: generatedMiniAppSchema,
		execute: async (generated) => {
			const build = await getActiveBuild(env, buildId);
			if (!build) {
				return JSON.stringify({ status: "ignored", message: `Build ${buildId} is already terminal or does not exist.` });
			}

			try {
				const payload = payloadFromBuild(build);
				const result = await deployGeneratedMiniAppCandidate({
					env,
					payload,
					generated: generated as GeneratedMiniApp,
					attempts: [{
						attempt: Math.max(1, build.attemptCount),
						status: "candidate_submitted",
						source: "mini-app-builder-agent",
						submissionId: build.currentRunId ?? undefined,
					}],
				});
				const succeeded = miniAppBuildSucceeded(result);
				await completeMiniAppBuild(env, {
					id: build.id,
					result: {
						...result,
						submissionId: build.currentRunId ?? undefined,
					},
					status: succeeded ? "completed" : "failed",
					error: succeeded ? undefined : {
						message: readResultMessage(result) ?? "Mini app build finished without an activatable app.",
						submissionId: build.currentRunId ?? undefined,
						source: "mini-app-builder-agent",
					},
				});

				return JSON.stringify({
					status: succeeded ? "completed" : "failed",
					result,
				});
			} catch (error) {
				const message = errorMessage(error);
				await failMiniAppBuild(env, {
					id: build.id,
					status: "failed",
					error: {
						message,
						submissionId: build.currentRunId ?? undefined,
						source: "mini-app-builder-agent",
					},
				});
				await auditMiniAppBuilderFailure(env, build, message);
				throw error;
			}
		},
	});
}

function failMiniAppBuildTool(env: Env, buildId: string) {
	return defineTool({
		name: "fail_mini_app_build",
		description: "Mark the current mini-app build as failed when no safe candidate can be generated.",
		parameters: v.object({
			message: v.string(),
		}),
		execute: async ({ message }) => {
			const build = await getActiveBuild(env, buildId);
			if (!build) {
				return JSON.stringify({ status: "ignored", message: `Build ${buildId} is already terminal or does not exist.` });
			}

			await failMiniAppBuild(env, {
				id: build.id,
				status: "failed",
				error: {
					message: message.trim() || "Mini app builder could not produce a safe candidate.",
					submissionId: build.currentRunId ?? undefined,
					source: "mini-app-builder-agent",
				},
			});
			await auditMiniAppBuilderFailure(env, build, message);

			return JSON.stringify({ status: "failed", buildId: build.id });
		},
	});
}

async function getActiveBuild(env: Env, buildId: string): Promise<MiniAppBuild | null> {
	const build = await getMiniAppBuild(env, buildId);
	if (!build || isTerminalBuild(build)) {
		return null;
	}
	return build;
}

function payloadFromBuild(build: MiniAppBuild): GenerateMiniAppPayload {
	return {
		prompt: build.prompt,
		operation: build.operation,
		...(build.targetSlug ? { targetSlug: build.targetSlug } : {}),
		...(build.slugHint ? { slugHint: build.slugHint } : {}),
		autonomousDeploy: build.autonomousDeploy,
		buildId: build.id,
		buildAttempt: Math.max(1, build.attemptCount),
		buildDeadlineAt: build.deadlineAt,
	};
}

function isTerminalBuild(build: MiniAppBuild): boolean {
	return build.status === "completed" || build.status === "failed" || build.status === "expired";
}

function readResultMessage(result: JsonObject): string | undefined {
	const message = result.message;
	if (typeof message === "string" && message.trim()) {
		return message;
	}
	const error = result.error;
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	return undefined;
}

export function miniAppBuilderToolErrorMessage(error: unknown): string {
	return errorMessage(error);
}

async function auditMiniAppBuilderFailure(env: Env, build: MiniAppBuild, message: string): Promise<void> {
	await createAuditRecord(env, {
		slug: build.targetSlug ?? build.slugHint ?? "agent",
		action: `${build.operation}-mini-app`,
		status: "build_failed",
		details: {
			buildId: build.id,
			submissionId: build.currentRunId ?? undefined,
			message: message.trim() || "Mini app builder failed.",
			source: "mini-app-builder-agent",
		},
	});
}
