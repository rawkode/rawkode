import { afterEach, describe, expect, it, vi } from "vitest";
import {
	candidateScriptNameForManifest,
	createMiniAppDispatchRequest,
	deleteMiniAppWorker,
	scriptNameForManifest,
	smokeTestMiniAppWorker,
} from "../src/lib/cloudflare-dispatch";
import { verifyHostContext } from "../src/lib/host-context";
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
const scopedManifest: ExtensionManifest = {
	...manifest,
	hostApis: ["resource-index:read"],
};

describe("Cloudflare dispatch helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses stable and candidate script names for mini app deployments", () => {
		expect(scriptNameForManifest(manifest)).toBe("enchiridion-hello-world");
		expect(candidateScriptNameForManifest(manifest)).toMatch(/^enchiridion-hello-world-[a-f0-9]{8}$/);
	});

	it("strips host credentials before dispatching to mini app workers", () => {
		const source = new Request("https://enchiridion.rawkodeacademy.workers.dev/apps/hello-world", {
			headers: {
				accept: "text/html",
				authorization: "Basic secret",
				cookie: "session=secret",
				"cf-access-jwt-assertion": "access-secret",
				"cf-access-authenticated-user-email": "rawkode@example.com",
				"x-enchiridion-host-context": "client-forged",
				"x-forwarded-for": "127.0.0.1",
			},
		});

		const request = createMiniAppDispatchRequest(source, "signed-host-context");

		expect(request.headers.get("accept")).toBe("text/html");
		expect(request.headers.get("x-enchiridion-host-context")).toBe("signed-host-context");
		expect(request.headers.get("authorization")).toBeNull();
		expect(request.headers.get("cookie")).toBeNull();
		expect(request.headers.get("cf-access-jwt-assertion")).toBeNull();
		expect(request.headers.get("cf-access-authenticated-user-email")).toBeNull();
		expect(request.headers.get("x-forwarded-for")).toBeNull();
	});

	it("omits host-context forwarding when no token is provided", () => {
		const source = new Request("https://enchiridion.rawkodeacademy.workers.dev/apps/hello-world", {
			headers: {
				accept: "text/html",
				"x-enchiridion-host-context": "client-forged",
			},
		});

		const request = createMiniAppDispatchRequest(source);

		expect(request.headers.get("accept")).toBe("text/html");
		expect(request.headers.get("x-enchiridion-host-context")).toBeNull();
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
			MINI_APP_DISPATCHER: {
				get(scriptName: string) {
					expect(scriptName).toBe("enchiridion-hello-world-candidate");
					return {
						async fetch(request: Request) {
							const url = new URL(request.url);
							requestedPath = url.pathname;
							expect(request.headers.get("x-enchiridion-host-context")).toBeNull();
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

	it("smoke tests every worker-page route through the dispatch binding", async () => {
		const requestedPaths: string[] = [];
		const multiRouteManifest: ExtensionManifest = {
			...manifest,
			routes: [
				{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" },
				{ path: "/apps/hello-world/fragment", mode: "worker-fragment", label: "Fragment" },
				{ path: "/apps/hello-world/settings", mode: "worker-page", label: "Settings" },
			],
		};
		const env = {
			MINI_APP_DISPATCHER: {
				get(scriptName: string) {
					expect(scriptName).toBe("enchiridion-hello-world-candidate");
					return {
						async fetch(request: Request) {
							const url = new URL(request.url);
							requestedPaths.push(url.pathname);
							return new Response(`<html><body><h1>${url.pathname}</h1></body></html>`, {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest: multiRouteManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(true);
		expect(result.route).toBe("/apps/hello-world");
		expect(result.message).toBe("All mini app worker-page routes rendered successfully.");
		expect(requestedPaths).toEqual([
			"/apps/hello-world",
			"/apps/hello-world/settings",
		]);
	});

	it("fails smoke testing when a secondary worker-page route fails", async () => {
		const requestedPaths: string[] = [];
		const multiRouteManifest: ExtensionManifest = {
			...manifest,
			routes: [
				{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" },
				{ path: "/apps/hello-world/settings", mode: "worker-page", label: "Settings" },
			],
		};
		const env = {
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch(request: Request) {
							const url = new URL(request.url);
							requestedPaths.push(url.pathname);
							if (url.pathname === "/apps/hello-world/settings") {
								return new Response("Load failed", { status: 500 });
							}

							return new Response("<html><body><h1>Hello</h1></body></html>", {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest: multiRouteManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.route).toBe("/apps/hello-world/settings");
		expect(result.status).toBe(500);
		expect(result.message).toContain("Load failed");
		expect(requestedPaths).toEqual([
			"/apps/hello-world",
			"/apps/hello-world/settings",
		]);
	});

	it("smoke tests scoped mini apps with a host-context token", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get(scriptName: string) {
					expect(scriptName).toBe("enchiridion-hello-world-candidate");
					return {
						async fetch(request: Request) {
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
			manifest: scopedManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(true);
	});

	it("signs scoped smoke-test host contexts for each worker-page route", async () => {
		const tokenPaths: string[] = [];
		const multiRouteManifest: ExtensionManifest = {
			...scopedManifest,
			routes: [
				{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" },
				{ path: "/apps/hello-world/settings", mode: "worker-page", label: "Settings" },
			],
		};
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch(request: Request) {
							const token = request.headers.get("x-enchiridion-host-context");
							expect(token).toBeTruthy();
							const payload = await verifyHostContext(token ?? "", "test-secret");
							tokenPaths.push(String(payload?.context.path));
							return new Response("<html><body><h1>Hello</h1></body></html>", {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest: multiRouteManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(true);
		expect(tokenPaths).toEqual([
			"/apps/hello-world",
			"/apps/hello-world/settings",
		]);
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
		expect(result.message).toContain("worker-page route must return text/html");
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
		expect(result.message).toContain("worker-page route returned an empty or non-HTML body");
	});

	it("rejects smoke tests that return unsafe dynamic HTML", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response('<html><head><meta http-equiv="refresh" content="0;url=/api/bootstrap"></head><body>Hello</body></html>', {
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
		expect(result.message).toContain("dynamic mini app pages cannot trigger meta refresh navigation");
	});

	it("rejects smoke tests that expose host-context tokens", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch(request: Request) {
							return new Response(`<html><body>${request.headers.get("x-enchiridion-host-context")}</body></html>`, {
								headers: { "content-type": "text/html" },
							});
						},
					};
				},
			},
		} as unknown as Env;

		const result = await smokeTestMiniAppWorker(env, {
			manifest: scopedManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(200);
		expect(result.message).toContain("dynamic mini app responses cannot expose host context tokens");
	});

	it("rejects smoke tests with oversized response bodies", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response(`<html><body>${"x".repeat(256 * 1024)}</body></html>`, {
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
		expect(result.message).toContain("dynamic mini app responses must be 262144 bytes or smaller");
	});

	it("rejects smoke tests with oversized content-length before reading the body", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response("<html><body>Hello</body></html>", {
								headers: {
									"content-type": "text/html",
									"content-length": String(256 * 1024 + 1),
								},
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
		expect(result.message).toContain("dynamic mini app responses must be 262144 bytes or smaller");
	});

	it("rejects smoke tests with content-encoded responses", async () => {
		const env = {
			HOST_SIGNING_SECRET: "test-secret",
			MINI_APP_DISPATCHER: {
				get() {
					return {
						async fetch() {
							return new Response("<html><body>Hello</body></html>", {
								headers: {
									"content-type": "text/html",
									"content-encoding": "gzip",
								},
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
		expect(result.message).toContain("dynamic mini app responses cannot set content-encoding");
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
			manifest: scopedManifest,
			scriptName: "enchiridion-hello-world-candidate",
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.message).toBe("HOST_SIGNING_SECRET is not configured.");
	});
});
