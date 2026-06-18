import { dispatch, type DispatchReceipt, type NamedAgentDispatchRequest } from "@flue/runtime";
import * as z from "zod";
import {
	createAuditRecord,
	createMiniAppBuild,
	failMiniAppBuild,
	markMiniAppBuildRunning,
} from "./repository";
import type { Env, MiniAppBuild } from "./types";

export const miniAppBuilderAgentName = "mini-app-builder";

export const miniAppBuildCreateSchema = z.object({
	prompt: z.string().min(1),
	operation: z.enum(["create", "update"]).default("create"),
	targetSlug: z.string().optional(),
	slugHint: z.string().optional(),
	autonomousDeploy: z.boolean().default(true),
});

export type MiniAppBuildCreateInput = z.infer<typeof miniAppBuildCreateSchema>;

export type MiniAppBuildDispatchInput = {
	buildId: string;
	prompt: string;
	operation: "create" | "update";
	targetSlug?: string;
	slugHint?: string;
	autonomousDeploy: boolean;
	buildAttempt: number;
	buildDeadlineAt: string;
};

type DispatchMiniAppBuild = (request: NamedAgentDispatchRequest) => Promise<DispatchReceipt>;

export async function admitMiniAppBuild(
	env: Env,
	input: MiniAppBuildCreateInput,
	options: { dispatchBuild?: DispatchMiniAppBuild } = {},
): Promise<MiniAppBuild> {
	const build = await createMiniAppBuild(env, input);
	await createAuditRecord(env, {
		slug: input.targetSlug ?? input.slugHint ?? "agent",
		action: `${input.operation}-mini-app`,
		status: "build_queued",
		details: {
			buildId: build.id,
			deadlineAt: build.deadlineAt,
			maxAttempts: build.maxAttempts,
		},
	});

	try {
		const admitted = await dispatchMiniAppBuildAttempt(env, build, 1, options);
		return admitted.build ?? build;
	} catch (error) {
		await failMiniAppBuild(env, {
			id: build.id,
			status: "failed",
			error: {
				message: errorMessage(error),
				source: "mini-app-build-admission",
			},
		});
		throw error;
	}
}

export async function dispatchMiniAppBuildAttempt(
	env: Env,
	build: MiniAppBuild,
	attempt: number,
	options: { dispatchBuild?: DispatchMiniAppBuild } = {},
): Promise<{ build: MiniAppBuild | null; receipt: DispatchReceipt }> {
	const boundedAttempt = Math.max(1, Math.trunc(attempt));
	const payload: MiniAppBuildDispatchInput = {
		buildId: build.id,
		prompt: build.prompt,
		operation: build.operation,
		...(build.targetSlug ? { targetSlug: build.targetSlug } : {}),
		...(build.slugHint ? { slugHint: build.slugHint } : {}),
		autonomousDeploy: build.autonomousDeploy,
		buildAttempt: boundedAttempt,
		buildDeadlineAt: build.deadlineAt,
	};
	const dispatchBuild = options.dispatchBuild ?? dispatch;
	const receipt = await dispatchBuild({
		agent: miniAppBuilderAgentName,
		id: build.id,
		input: payload,
	});
	const runningBuild = await markMiniAppBuildRunning(env, {
		id: build.id,
		runId: receipt.dispatchId,
		attempt: boundedAttempt,
	});

	await createAuditRecord(env, {
		slug: build.targetSlug ?? build.slugHint ?? "agent",
		action: `${build.operation}-mini-app`,
		status: boundedAttempt === 1 ? "build_dispatched" : "build_retry_dispatched",
		details: {
			buildId: build.id,
			attempt: boundedAttempt,
			submissionId: receipt.dispatchId,
			acceptedAt: receipt.acceptedAt,
			deadlineAt: build.deadlineAt,
		},
	});

	return { build: runningBuild, receipt };
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || "Mini app build failed.";
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object") {
		const source = error as Record<string, unknown>;
		if (typeof source.message === "string" && source.message.trim()) {
			return source.message;
		}
		if (typeof source.error === "string" && source.error.trim()) {
			return source.error;
		}
		try {
			return JSON.stringify(error);
		} catch {
			return "Mini app build failed.";
		}
	}

	return String(error || "Mini app build failed.");
}
