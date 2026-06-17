import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/lib/types";

const mockState = vi.hoisted(() => ({
	audits: [] as Array<Record<string, unknown>>,
	savedExtensions: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/repository", () => ({
	createAuditRecord: vi.fn(async (_env: Env, record: Record<string, unknown>) => {
		mockState.audits.push(record);
	}),
	listRegisteredExtensions: vi.fn(async () => []),
	saveExtension: vi.fn(async (_env: Env, manifest: Record<string, unknown>, scriptName: string | null, status: string) => {
		mockState.savedExtensions.push({ manifest, scriptName, status });
	}),
}));

vi.mock("../src/lib/cloudflare-dispatch", () => ({
	candidateScriptNameForManifest: vi.fn((manifest: { slug: string }) => `enchiridion-${manifest.slug}-candidate`),
	deleteMiniAppWorker: vi.fn(async (_env: Env, scriptName: string) => ({
		scriptName,
		deleted: true,
		message: "Mini app Worker candidate removed.",
	})),
	deployMiniAppWorker: vi.fn(async (_env: Env, input: { scriptName?: string }) => ({
		scriptName: input.scriptName ?? "enchiridion-test-candidate",
		deployed: true,
		message: "Mini app Worker deployed.",
	})),
	scriptNameForManifest: vi.fn((manifest: { slug: string }) => `enchiridion-${manifest.slug}`),
	smokeTestMiniAppWorker: vi.fn(async (_env: Env, input: { manifest: { routes: Array<{ path: string }> } }) => ({
		ok: true,
		route: input.manifest.routes[0]?.path ?? "/apps/test",
		status: 200,
		contentType: "text/html; charset=utf-8",
		message: "Primary mini-app route rendered successfully.",
	})),
}));

describe("generate mini app workflow recovery", () => {
	beforeEach(() => {
		mockState.audits.length = 0;
		mockState.savedExtensions.length = 0;
		vi.clearAllMocks();
	});

	it("deploys a deterministic fallback when model generation fails before a candidate exists", async () => {
		const { run } = await import("../src/workflows/generate-mini-app");

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Web app Kubernetes how to for topology spread constraints",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => {
						throw new Error("Load failed");
					},
				}),
			}),
		} as never);

		expect(result).toMatchObject({
			status: "deployed",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: true,
			fallback: true,
			routeUrl: "/apps/kubernetes-topology-spread-constraints",
		});
		expect(result.message).toContain("LLM generation failed; deployed a static fallback mini app.");
		expect(result.attempts).toEqual([
			{ attempt: 1, status: "generation_failed", message: "Load failed" },
		]);
		expect(mockState.savedExtensions).toHaveLength(1);
		expect(mockState.audits[0]).toMatchObject({
			slug: "kubernetes-topology-spread-constraints",
			status: "fallback_deployed",
			details: {
				previousFailureStatus: "generation_failed",
				previousFailure: { message: "Load failed" },
			},
		});
	});
});
