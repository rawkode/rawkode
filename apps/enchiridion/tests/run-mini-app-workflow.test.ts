import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyHostContext } from "../src/lib/host-context";
import type { Env, RegisteredExtension } from "../src/lib/types";

const mockState = vi.hoisted(() => ({
	audits: [] as Array<Record<string, unknown>>,
	extension: null as RegisteredExtension | null,
}));

vi.mock("../src/lib/repository", () => ({
	createAuditRecord: vi.fn(async (_env: Env, record: Record<string, unknown>) => {
		mockState.audits.push(record);
	}),
	getExtension: vi.fn(async (_env: Env, slug: string) => mockState.extension?.slug === slug ? mockState.extension : null),
}));

const rssReaderExtension: RegisteredExtension = {
	slug: "rss-reader",
	name: "RSS Reader",
	version: "0.1.0",
	description: "Read RSS feeds.",
	status: "dynamic",
	routes: [
		{ path: "/apps/rss-reader", mode: "worker-page", label: "RSS Reader" },
		{ path: "/apps/rss-reader/_workflows/refresh-feeds", mode: "worker-fragment", label: "Refresh feeds" },
	],
	commands: [],
	editorBlocks: [],
	workflows: [{
		id: "refresh-feeds",
		label: "Refresh feeds",
		trigger: "scheduled",
		workflowName: "run-mini-app-workflow",
		cron: "*/15 * * * *",
		requiredHostApis: ["resource-index:read"],
	}],
	bindings: [],
	hostApis: ["resource-index:read"],
	indexProjections: [],
	deployedScriptName: "enchiridion-rss-reader",
};

describe("run mini app workflow", () => {
	beforeEach(() => {
		mockState.audits.length = 0;
		mockState.extension = rssReaderExtension;
		vi.clearAllMocks();
	});

	it("dispatches a scheduled callback to the mini app Worker with scoped host context", async () => {
		const { run } = await import("../src/workflows/run-mini-app-workflow");
		let dispatchedRequest: Request | null = null;
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get(scriptName: string) {
					expect(scriptName).toBe("enchiridion-rss-reader");
					return {
						async fetch(request: Request) {
							dispatchedRequest = request;
							return new Response(JSON.stringify({ ok: true, imported: 3 }), {
								headers: { "content-type": "application/json" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await run({
			env,
			payload: {
				app: "rss-reader",
				extensionSlug: "rss-reader",
				workflowId: "refresh-feeds",
				scheduledWorkflow: {
					id: "rss-reader:refresh-feeds",
					scheduledAt: "2026-06-18T12:15:00.000Z",
				},
			},
		} as never);

		expect(result).toMatchObject({
			callbackPath: "/apps/rss-reader/_workflows/refresh-feeds",
			responseBody: "{\"ok\":true,\"imported\":3}",
			responseStatus: 200,
			scheduledAt: "2026-06-18T12:15:00.000Z",
			scheduledWorkflowId: "rss-reader:refresh-feeds",
			workflowId: "refresh-feeds",
		});
		expect(dispatchedRequest).toBeTruthy();
		const request = dispatchedRequest as unknown as Request;
		expect(request.method).toBe("POST");
		expect(new URL(request.url).pathname).toBe("/apps/rss-reader/_workflows/refresh-feeds");
		const token = request.headers.get("x-enchiridion-host-context");
		expect(token).toBeTruthy();
		expect(await verifyHostContext(token ?? "", "test-secret")).toMatchObject({
			app: "rss-reader",
			scopes: ["resource-index:read"],
			context: {
				path: "/apps/rss-reader/_workflows/refresh-feeds",
				scheduledAt: "2026-06-18T12:15:00.000Z",
				workflowId: "refresh-feeds",
			},
		});
		expect(mockState.audits).toEqual([expect.objectContaining({
			action: "mini-app-workflow",
			slug: "rss-reader",
			status: "completed",
		})]);
	});

	it("rejects callbacks for undeclared workflow routes", async () => {
		const { run } = await import("../src/workflows/run-mini-app-workflow");
		mockState.extension = {
			...rssReaderExtension,
			routes: [{ path: "/apps/rss-reader", mode: "worker-page", label: "RSS Reader" }],
		};

		await expect(run({
			env: {
				HOST_SIGNING_SECRET: "test-secret",
				MINI_APP_DISPATCHER: { get: vi.fn() },
			} as unknown as Env,
			payload: {
				extensionSlug: "rss-reader",
				workflowId: "refresh-feeds",
				scheduledWorkflow: {
					id: "rss-reader:refresh-feeds",
					scheduledAt: "2026-06-18T12:15:00.000Z",
				},
			},
		} as never)).rejects.toThrow("does not declare workflow callback route");

		expect(mockState.audits).toEqual([expect.objectContaining({
			action: "mini-app-workflow",
			slug: "rss-reader",
			status: "failed",
			details: expect.objectContaining({
				workflowId: "refresh-feeds",
			}),
		})]);
	});
});
