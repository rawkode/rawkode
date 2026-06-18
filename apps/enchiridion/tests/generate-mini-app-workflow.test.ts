import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, RegisteredExtension } from "../src/lib/types";

const mockState = vi.hoisted(() => ({
	audits: [] as Array<Record<string, unknown>>,
	deployments: [] as Array<Record<string, unknown>>,
	registeredExtensions: [] as RegisteredExtension[],
	savedExtensions: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/repository", () => ({
	createAuditRecord: vi.fn(async (_env: Env, record: Record<string, unknown>) => {
		mockState.audits.push(record);
	}),
	listRegisteredExtensions: vi.fn(async () => mockState.registeredExtensions),
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
	deployMiniAppWorker: vi.fn(async (_env: Env, input: { scriptName?: string; manifest: { slug: string } }) => {
		mockState.deployments.push(input);
		return {
			scriptName: input.scriptName ?? "enchiridion-test-candidate",
			deployed: true,
			message: "Mini app Worker deployed.",
		};
	}),
	isTransientMiniAppLoadFailure: vi.fn((message: string) => /\bLoad failed\b/i.test(message)),
	scriptNameForManifest: vi.fn((manifest: { slug: string }) => `enchiridion-${manifest.slug}`),
	smokeTestMiniAppWorker: vi.fn(async (_env: Env, input: { manifest: { routes: Array<{ path: string }> } }) => ({
		ok: true,
		route: input.manifest.routes[0]?.path ?? "/apps/test",
		status: 200,
		contentType: "text/html; charset=utf-8",
		message: "Primary mini-app route rendered successfully.",
	})),
}));

const helloWorldExtension: RegisteredExtension = {
	slug: "hello-world",
	name: "Hello World",
	version: "0.1.0",
	description: "A generated hello world app.",
	status: "dynamic",
	routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
	commands: [],
	editorBlocks: [],
	workflows: [],
	bindings: [],
	hostApis: [],
	indexProjections: [],
	deployedScriptName: "enchiridion-hello-world-old",
};

describe("generate mini app workflow recovery", () => {
	beforeEach(() => {
		mockState.audits.length = 0;
		mockState.deployments.length = 0;
		mockState.registeredExtensions.length = 0;
		mockState.savedExtensions.length = 0;
		vi.clearAllMocks();
	});

	it("retries transient model generation failures before falling back", async () => {
		const { run } = await import("../src/workflows/generate-mini-app");
		let promptCalls = 0;

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Simple hello world web app",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => {
						promptCalls += 1;
						if (promptCalls === 1) {
							throw new Error("Load failed");
						}

						return {
							data: {
								manifest: {
									slug: "hello-world",
									name: "Hello World",
									version: "0.1.0",
									description: "A generated hello world app.",
									routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
									commands: [],
									editorBlocks: [],
									workflows: [],
									bindings: [],
									hostApis: [],
									indexProjections: [],
								},
								workerSource: "export default { fetch() { return new Response('<html><body><h1>Hello</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) } }",
								deploymentNotes: "Generated after retry.",
							},
						};
					},
				}),
			}),
		} as never);

		expect(result).toMatchObject({
			status: "deployed",
			operation: "create",
			slug: "hello-world",
			deployed: true,
			routeUrl: "/apps/hello-world",
		});
		expect((result as Record<string, unknown>).fallback).toBeUndefined();
		expect(result.attempts).toEqual([
			{ attempt: 1, status: "generation_failed", message: "Load failed" },
		]);
		expect(promptCalls).toBe(2);
		expect(mockState.deployments).toHaveLength(1);
		expect(mockState.deployments[0]?.manifest).toMatchObject({ slug: "hello-world" });
	});

	it("retries transient candidate smoke test load failures before activating the app", async () => {
		const { smokeTestMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		vi.mocked(smokeTestMiniAppWorker).mockResolvedValueOnce({
			ok: false,
			route: "/apps/hello-world",
			message: "Load failed",
		});
		const { run } = await import("../src/workflows/generate-mini-app");

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Simple hello world web app",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => ({
						data: {
							manifest: {
								slug: "hello-world",
								name: "Hello World",
								version: "0.1.0",
								description: "A generated hello world app.",
								routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
								commands: [],
								editorBlocks: [],
								workflows: [],
								bindings: [],
								hostApis: [],
								indexProjections: [],
							},
							workerSource: "export default { fetch() { return new Response('<html><body><h1>Hello</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) } }",
							deploymentNotes: "Generated app.",
						},
					}),
				}),
			}),
		} as never);

		expect(result).toMatchObject({
			status: "deployed",
			operation: "create",
			slug: "hello-world",
			deployed: true,
			routeUrl: "/apps/hello-world",
			validationAttempts: [
				{ attempt: 1, status: "failed", route: "/apps/hello-world", message: "Load failed" },
				{ attempt: 2, status: "passed", route: "/apps/hello-world", message: "Primary mini-app route rendered successfully." },
			],
		});
		expect(smokeTestMiniAppWorker).toHaveBeenCalledTimes(2);
		expect(mockState.savedExtensions).toHaveLength(1);
		expect(mockState.audits[0]).toMatchObject({
			slug: "hello-world",
			status: "deployed",
			details: {
				validationAttempts: [
					{ attempt: 1, status: "failed", message: "Load failed" },
					{ attempt: 2, status: "passed", message: "Primary mini-app route rendered successfully." },
				],
			},
		});
	});

	it("registers a generated candidate as pending when only dispatch loading stays transient", async () => {
		const { smokeTestMiniAppWorker, deleteMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		vi.mocked(smokeTestMiniAppWorker)
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"));
		const { run } = await import("../src/workflows/generate-mini-app");

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Simple hello world web app",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => ({
						data: {
							manifest: {
								slug: "hello-world",
								name: "Hello World",
								version: "0.1.0",
								description: "A generated hello world app.",
								routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
								commands: [],
								editorBlocks: [],
								workflows: [],
								bindings: [],
								hostApis: [],
								indexProjections: [],
							},
							workerSource: "export default { fetch() { return new Response('<html><body><h1>Hello</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) } }",
							deploymentNotes: "Generated app.",
						},
					}),
				}),
			}),
		} as never);

		expect(result).toMatchObject({
			status: "deployed_pending",
			operation: "create",
			slug: "hello-world",
			deployed: true,
			routeUrl: "/apps/hello-world",
			validationAttempts: [
				{ attempt: 1, status: "failed", route: "/apps/hello-world", message: "Load failed" },
				{ attempt: 2, status: "failed", route: "/apps/hello-world", message: "Load failed" },
				{ attempt: 3, status: "failed", route: "/apps/hello-world", message: "Load failed" },
				{ attempt: 4, status: "failed", route: "/apps/hello-world", message: "Load failed" },
			],
		});
		expect(mockState.savedExtensions).toEqual([
			expect.objectContaining({
				scriptName: "enchiridion-hello-world-candidate",
				status: "dynamic",
				manifest: expect.objectContaining({ slug: "hello-world" }),
			}),
		]);
		expect(deleteMiniAppWorker).not.toHaveBeenCalled();
		expect(mockState.audits[0]).toMatchObject({
			slug: "hello-world",
			status: "deployed_pending",
		});
		expect((mockState.audits[0]?.details as Record<string, unknown>).validationAttempts).toEqual(expect.arrayContaining([
			expect.objectContaining({ attempt: 1, status: "failed", message: "Load failed" }),
			expect.objectContaining({ attempt: 4, status: "failed", message: "Load failed" }),
		]));
	});

	it("cleans up the superseded Worker after a successful dynamic mini app update", async () => {
		mockState.registeredExtensions.push(helloWorldExtension);
		const { deleteMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		const { run } = await import("../src/workflows/generate-mini-app");

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Update hello world app to have blue background",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => ({
						data: {
							manifest: {
								slug: "hello-world",
								name: "Hello World",
								version: "0.2.0",
								description: "A generated hello world app with blue styling.",
								routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
								commands: [],
								editorBlocks: [],
								workflows: [],
								bindings: [],
								hostApis: [],
								indexProjections: [],
							},
							workerSource: "export default { fetch() { return new Response('<html><body style=\"background:#2563eb\"><h1>Hello</h1></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) } }",
							deploymentNotes: "Updated app styling.",
						},
					}),
				}),
			}),
		} as never);

		expect(result).toMatchObject({
			status: "updated",
			operation: "update",
			slug: "hello-world",
			deployed: true,
			routeUrl: "/apps/hello-world",
			supersededScriptCleanup: {
				scriptName: "enchiridion-hello-world-old",
				deleted: true,
				message: "Mini app Worker candidate removed.",
			},
		});
		expect(mockState.savedExtensions).toEqual([
			expect.objectContaining({
				scriptName: "enchiridion-hello-world-candidate",
				status: "dynamic",
				manifest: expect.objectContaining({ slug: "hello-world", version: "0.2.0" }),
			}),
		]);
		expect(deleteMiniAppWorker).toHaveBeenCalledWith(expect.anything(), "enchiridion-hello-world-old");
		expect(mockState.audits[0]).toMatchObject({
			slug: "hello-world",
			status: "updated",
			details: {
				scriptName: "enchiridion-hello-world-candidate",
				supersededScriptName: "enchiridion-hello-world-old",
				supersededScriptCleanup: {
					scriptName: "enchiridion-hello-world-old",
					deleted: true,
				},
			},
		});
	});

	it("deploys a deterministic fallback when model generation fails before a candidate exists", async () => {
		const { run } = await import("../src/workflows/generate-mini-app");
		let promptCalls = 0;

		const result = await run({
			env: {} as Env,
			payload: {
				prompt: "Web app Kubernetes how to for topology spread constraints",
				autonomousDeploy: true,
			},
			init: async () => ({
				session: async () => ({
					prompt: async () => {
						promptCalls += 1;
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
			{ attempt: 2, status: "generation_failed", message: "Load failed" },
			{ attempt: 3, status: "generation_failed", message: "Load failed" },
		]);
		expect(promptCalls).toBe(3);
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

	it("returns a structured fallback failure when fallback deployment throws", async () => {
		const { deployMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		vi.mocked(deployMiniAppWorker).mockRejectedValueOnce(new Error("Dispatch upload failed"));
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
			status: "fallback_deploy_failed",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: false,
			message: "Dispatch upload failed",
		});
		expect(mockState.savedExtensions).toHaveLength(0);
		expect(mockState.audits[0]).toMatchObject({
			slug: "kubernetes-topology-spread-constraints",
			status: "fallback_deploy_failed",
			details: {
				previousFailureStatus: "generation_failed",
				message: "Dispatch upload failed",
			},
		});
	});

	it("retries transient fallback smoke test load failures before activating the fallback", async () => {
		const { smokeTestMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		vi.mocked(smokeTestMiniAppWorker).mockRejectedValueOnce(new Error("Load failed"));
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
			validationAttempts: [
				{ attempt: 1, status: "failed", route: "/apps/kubernetes-topology-spread-constraints", message: "Load failed" },
				{ attempt: 2, status: "passed", route: "/apps/kubernetes-topology-spread-constraints", message: "Primary mini-app route rendered successfully." },
			],
		});
		expect(smokeTestMiniAppWorker).toHaveBeenCalledTimes(2);
		expect(mockState.savedExtensions).toHaveLength(1);
		expect(mockState.audits[0]).toMatchObject({
			slug: "kubernetes-topology-spread-constraints",
			status: "fallback_deployed",
			details: {
				previousFailureStatus: "generation_failed",
				validationAttempts: [
					{ attempt: 1, status: "failed", message: "Load failed" },
					{ attempt: 2, status: "passed", message: "Primary mini-app route rendered successfully." },
				],
			},
		});
	});

	it("registers a deterministic fallback as pending after repeated transient dispatch load failures", async () => {
		const { smokeTestMiniAppWorker, deleteMiniAppWorker } = await import("../src/lib/cloudflare-dispatch");
		vi.mocked(smokeTestMiniAppWorker)
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"))
			.mockRejectedValueOnce(new Error("Load failed"));
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
			status: "deployed_pending",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: true,
			fallback: true,
			routeUrl: "/apps/kubernetes-topology-spread-constraints",
		});
		expect(smokeTestMiniAppWorker).toHaveBeenCalledTimes(4);
		expect(mockState.savedExtensions).toEqual([
			expect.objectContaining({
				scriptName: "enchiridion-kubernetes-topology-spread-constraints-candidate",
				status: "dynamic",
				manifest: expect.objectContaining({ slug: "kubernetes-topology-spread-constraints" }),
			}),
		]);
		expect(deleteMiniAppWorker).not.toHaveBeenCalled();
		expect(mockState.audits[0]).toMatchObject({
			slug: "kubernetes-topology-spread-constraints",
			status: "fallback_deployed_pending",
			details: {
				previousFailureStatus: "generation_failed",
				validationAttempts: [
					{ attempt: 1, status: "failed", message: "Load failed" },
					{ attempt: 2, status: "failed", message: "Load failed" },
					{ attempt: 3, status: "failed", message: "Load failed" },
					{ attempt: 4, status: "failed", message: "Load failed" },
				],
			},
		});
	});
});
