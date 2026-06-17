import { afterEach, describe, expect, it, vi } from "vitest";
import {
	candidateScriptNameForManifest,
	deleteMiniAppWorker,
	scriptNameForManifest,
	smokeTestMiniAppWorker,
} from "../src/lib/cloudflare-dispatch";
import type { Env, ExtensionManifest } from "../src/lib/types";

const manifest: ExtensionManifest = {
	slug: "hello-world",
	name: "Hello World",
	version: "0.1.0",
	description: "A simple generated app.",
	status: "dynamic",
	routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
	commands: [],
	editorBlocks: [],
	workflows: [],
	bindings: [],
	hostApis: [],
	indexProjections: [],
};

describe("Cloudflare dispatch helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses stable and candidate script names for mini app deployments", () => {
		expect(scriptNameForManifest(manifest)).toBe("enchiridion-hello-world");
		expect(candidateScriptNameForManifest(manifest)).toMatch(/^enchiridion-hello-world-[a-f0-9]{8}$/);
	});

	it("deletes failed candidate mini app workers from the dispatch namespace", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const env = {
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CLOUDFLARE_API_TOKEN: "token",
			CLOUDFLARE_DISPATCH_NAMESPACE: "enchiridion-mini-apps",
		} as unknown as Env;

		const result = await deleteMiniAppWorker(env, "enchiridion-hello-world-candidate");

		expect(result.deleted).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/enchiridion-mini-apps/scripts/enchiridion-hello-world-candidate",
			expect.objectContaining({
				method: "DELETE",
				headers: { authorization: "Bearer token" },
			}),
		);
	});

	it("smoke tests the primary worker-page route through the dispatch binding", async () => {
		let requestedPath = "";
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get(scriptName: string) {
					expect(scriptName).toBe("enchiridion-hello-world-candidate");
					return {
						async fetch(request: Request) {
							const url = new URL(request.url);
							requestedPath = url.pathname;
							expect(request.headers.get("x-enchiridion-host-context")).toBeTruthy();
							return new Response("<html><body>Hello</body></html>", {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(true);
		expect(result.route).toBe("/apps/hello-world");
		expect(requestedPath).toBe("/apps/hello-world");
	});

	it("reports smoke test failures without throwing", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response("Load failed", { status: 500 });
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.message).toContain("Load failed");
	});

	it("rejects smoke tests that do not return HTML", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return Response.json({ ok: true });
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(200);
		expect(result.contentType).toContain("application/json");
		expect(result.message).toContain("primary route must return text/html");
	});

	it("rejects smoke tests that return empty or generic HTML", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response("OK", {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(200);
		expect(result.message).toContain("primary route returned an empty or non-HTML body");
	});

	it("fails smoke tests when production signing material is missing", async () => {
		const env = {
			MINI_APP_DISPATCHER: {
				get() {
					throw new Error("dispatcher should not be called without signing material");
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.message).toBe("HOST_SIGNING_SECRET is not configured.");
	});
});
