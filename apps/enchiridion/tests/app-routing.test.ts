import { describe, expect, it } from "vitest";
import app from "../src/app";
import { signSchedulerWorkflowRequest, verifyHostContext } from "../src/lib/host-context";
import type { Env, RegisteredExtension } from "../src/lib/types";

const helloWorldExtension: RegisteredExtension = {
	slug: "hello-world",
	name: "Hello World",
	version: "0.1.0",
	description: "A generated mini app.",
	status: "dynamic",
	routes: [{ path: "/apps/hello-world", mode: "worker-page", label: "Hello World" }],
	commands: [],
	editorBlocks: [],
	workflows: [],
	bindings: [],
	hostApis: ["resource-index:read"],
	indexProjections: [],
	deployedScriptName: "enchiridion-hello-world",
};

describe("app mini app routing", () => {
	it("does not allow unsigned requests to invoke Flue workflow routes", async () => {
		const { env } = testEnv(null);
		const response = await app.fetch(new Request("https://enchiridion.example.com/api/flue/workflows/rss-refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		}), env);

		expect(response.status).toBe(401);
	});

	it("allows signed scheduler requests to reach Flue workflow routes", async () => {
		const { env } = testEnv(null);
		const path = "/api/flue/workflows/rss-refresh";
		const token = await signSchedulerWorkflowRequest({
			path,
			scheduledAt: "2026-06-18T12:00:00.000Z",
			secret: "test-secret",
		});
		const response = await app.fetch(new Request(`https://enchiridion.example.com${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-enchiridion-scheduler": token,
			},
			body: "{}",
		}), env);

		expect(response.status).not.toBe(401);
	});

	it("updates scheduled workflow enablement through the host API", async () => {
		const calls: Array<{ sql: string; bindings: unknown[]; method: "run" }> = [];
		let enabled = 0;
		const env = {
			DB: {
				prepare(sql: string) {
					let bindings: unknown[] = [];
					const statement = {
						bind(...values: unknown[]) {
							bindings = values;
							return statement;
						},
						async run() {
							calls.push({ sql, bindings, method: "run" });
							if (sql.includes("UPDATE scheduled_workflows")) {
								enabled = Number(bindings[0]);
							}
							return { success: true };
						},
						async first() {
							if (/SELECT COUNT\(\*\) AS count FROM (bookmarks|projects)/.test(sql)) {
								return { count: 1 };
							}
							if (/SELECT \* FROM scheduled_workflows WHERE id = \?/.test(sql)) {
								return scheduledWorkflowRow(enabled);
							}
							return null;
						},
						async all() {
							return { results: [] };
						},
					};
					return statement;
				},
			},
			ASSETS: {
				async fetch() {
					return new Response("asset-shell", {
						headers: { "content-type": "text/html" },
					});
				},
			},
		} as unknown as Env;

		const response = await app.fetch(new Request("http://localhost/api/scheduled-workflows/rss-reader%3Arefresh-feeds", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		}), env);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "rss-reader:refresh-feeds",
			enabled: true,
		});
		expect(calls.some((call) =>
			call.sql.includes("UPDATE scheduled_workflows")
			&& call.bindings[0] === 1
			&& call.bindings[2] === "rss-reader:refresh-feeds"
		)).toBe(true);
		expect(calls.some((call) =>
			call.sql.includes("INSERT INTO mini_app_audit")
			&& call.bindings[1] === "rss-reader"
			&& call.bindings[2] === "scheduled-workflow"
			&& call.bindings[3] === "enabled"
		)).toBe(true);
	});

	it("lists extension binding requests through the host API", async () => {
		const env = {
			DB: {
				prepare(sql: string) {
					let bindings: unknown[] = [];
					const statement = {
						bind(...values: unknown[]) {
							bindings = values;
							return statement;
						},
						async run() {
							return { success: true };
						},
						async first() {
							if (/SELECT COUNT\(\*\) AS count FROM (bookmarks|projects)/.test(sql)) {
								return { count: 1 };
							}
							return null;
						},
						async all() {
							if (sql.includes("extension_binding_requests")) {
								expect(bindings).toEqual(["pending", 10]);
								return {
									results: [{
										id: "request-1",
										extension_slug: "rss-reader",
										extension_name: "RSS Reader",
										operation: "create",
										manifest_json: JSON.stringify({ ...helloWorldExtension, slug: "rss-reader", name: "RSS Reader" }),
										worker_source: "export default {}",
										deployment_notes: "Needs D1.",
										bindings_json: JSON.stringify([{ type: "d1_database", name: "RSS_DB", purpose: "Feeds." }]),
										issues_json: JSON.stringify(["needs provisioning"]),
										status: "pending",
										created_at: "2026-06-18T12:00:00.000Z",
										updated_at: "2026-06-18T12:00:00.000Z",
									}],
								};
							}
							return { results: [] };
						},
					};
					return statement;
				},
			},
			ASSETS: {
				async fetch() {
					return new Response("asset-shell", {
						headers: { "content-type": "text/html" },
					});
				},
			},
		} as unknown as Env;

		const response = await app.fetch(new Request("http://localhost/api/extension-binding-requests?status=pending&limit=10"), env);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([expect.objectContaining({
			id: "request-1",
			extensionSlug: "rss-reader",
			status: "pending",
			bindings: [{ type: "d1_database", name: "RSS_DB", purpose: "Feeds." }],
		})]);
	});

	it("dispatches exact dynamic mini app routes instead of falling through to assets", async () => {
		const { env, dispatchedRequests } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/apps/hello-world", {
			headers: {
				accept: "text/html",
				authorization: "Basic client-secret",
				cookie: "session=secret",
			},
		}), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("mini-app:/apps/hello-world");
		expect(dispatchedRequests).toHaveLength(1);
		expect(dispatchedRequests[0]?.headers.get("accept")).toBe("text/html");
		expect(dispatchedRequests[0]?.headers.get("authorization")).toBeNull();
		expect(dispatchedRequests[0]?.headers.get("cookie")).toBeNull();
		expect(dispatchedRequests[0]?.headers.get("x-enchiridion-host-context")).toBeTruthy();
	});

	it("does not mint host-context tokens for mini apps without host API scopes", async () => {
		const { env, dispatchedRequests } = testEnv({
			...helloWorldExtension,
			hostApis: [],
		});
		delete (env as Partial<Env>).HOST_SIGNING_SECRET;

		const response = await app.fetch(new Request("http://localhost/apps/hello-world", {
			headers: { accept: "text/html" },
		}), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("mini-app:/apps/hello-world");
		expect(dispatchedRequests).toHaveLength(1);
		expect(dispatchedRequests[0]?.headers.get("x-enchiridion-host-context")).toBeNull();
	});

	it("sandboxes dynamic mini app responses and strips response credentials", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response("<html><body>Hello</body></html>", {
			headers: {
				"content-type": "text/html",
				refresh: "0;url=/api/bootstrap",
				"set-cookie": "mini_app_session=secret",
				"x-enchiridion-host-context": "leaked-token",
			},
		}));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("refresh")).toBeNull();
		expect(response.headers.get("x-enchiridion-host-context")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
		expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
		expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
	});

	it("drops arbitrary dynamic mini app response headers", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response("<html><body>Hello</body></html>", {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"access-control-allow-origin": "*",
				"content-disposition": "attachment; filename=mini-app.html",
				link: "<https://example.com/style.css>; rel=preload",
				"report-to": "{\"group\":\"mini-app\"}",
				"x-powered-by": "generated-worker",
			},
		}));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(response.headers.get("content-disposition")).toBeNull();
		expect(response.headers.get("link")).toBeNull();
		expect(response.headers.get("report-to")).toBeNull();
		expect(response.headers.get("x-powered-by")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("blocks dynamic mini app HTML bodies with browser execution surfaces", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response(
			'<html><body><script>fetch("/api/bootstrap")</script></body></html>',
			{ headers: { "content-type": "text/html" } },
		));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app pages cannot include browser scripts",
		});
	});

	it("blocks dynamic mini app HTML bodies with meta refresh navigation", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response(
			'<html><head><meta http-equiv="refresh" content="0;url=/api/bootstrap"></head><body>Hello</body></html>',
			{ headers: { "content-type": "text/html" } },
		));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app pages cannot trigger meta refresh navigation",
		});
	});

	it("blocks dynamic mini app HTML bodies that expose host-context tokens", async () => {
		const { env } = testEnv(helloWorldExtension, (request) => new Response(
			`<html><body><pre>${request.headers.get("x-enchiridion-host-context")}</pre></body></html>`,
			{ headers: { "content-type": "text/html" } },
		));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app responses cannot expose host context tokens",
		});
	});

	it("blocks dynamic mini app non-HTML bodies that expose host-context tokens", async () => {
		const { env } = testEnv({
			...helloWorldExtension,
			routes: [
				...helloWorldExtension.routes,
				{ path: "/apps/hello-world/data", mode: "worker-fragment", label: "Data" },
			],
		}, (request) => Response.json({
			token: request.headers.get("x-enchiridion-host-context"),
		}));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world/data"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app responses cannot expose host context tokens",
		});
	});

	it("blocks oversized dynamic mini app responses", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response(
			`<html><body>${"x".repeat(256 * 1024)}</body></html>`,
			{ headers: { "content-type": "text/html" } },
		));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app responses must be 262144 bytes or smaller",
		});
	});

	it("blocks content-encoded dynamic mini app responses", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response("<html><body>Hello</body></html>", {
			headers: {
				"content-type": "text/html",
				"content-encoding": "gzip",
			},
		}));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app response blocked",
			slug: "hello-world",
			reason: "dynamic mini app responses cannot set content-encoding",
		});
		expect(response.headers.get("content-encoding")).toBeNull();
	});

	it("allows dynamic mini app redirects inside the same app route namespace", async () => {
		const { env } = testEnv(helloWorldExtension, () => new Response(null, {
			status: 302,
			headers: {
				location: "http://localhost/apps/hello-world/settings",
				"set-cookie": "mini_app_session=secret",
				link: "<https://example.com/style.css>; rel=preload",
			},
		}));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("http://localhost/apps/hello-world/settings");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("link")).toBeNull();
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
	});

	it("blocks dynamic mini app redirects that expose host-context tokens", async () => {
		const { env } = testEnv(helloWorldExtension, (request) => {
			const token = request.headers.get("x-enchiridion-host-context");
			return Response.redirect(`http://localhost/apps/hello-world/settings?token=${encodeURIComponent(token ?? "")}`, 302);
		});
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app redirect blocked",
			slug: "hello-world",
			reason: "dynamic mini app redirects cannot expose host context tokens",
		});
		expect(response.headers.get("location")).toBeNull();
	});

	it("blocks dynamic mini app redirects to host APIs", async () => {
		const { env } = testEnv(helloWorldExtension, () => Response.redirect("http://localhost/api/bootstrap", 302));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app redirect blocked",
			slug: "hello-world",
		});
		expect(response.headers.get("location")).toBeNull();
	});

	it("blocks dynamic mini app redirects to external origins", async () => {
		const { env } = testEnv(helloWorldExtension, () => Response.redirect("https://example.com/apps/hello-world", 302));
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Unsafe mini app redirect blocked",
			slug: "hello-world",
		});
	});

	it("dispatches nested dynamic mini app routes", async () => {
		const { env } = testEnv({
			...helloWorldExtension,
			routes: [
				...helloWorldExtension.routes,
				{ path: "/apps/hello-world/settings", mode: "worker-page", label: "Settings" },
			],
		});
		const response = await app.fetch(new Request("http://localhost/apps/hello-world/settings"), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("mini-app:/apps/hello-world/settings");
	});

	it("does not dispatch undeclared dynamic mini app routes", async () => {
		const { env, dispatchedRequests } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/apps/hello-world/settings"), env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Mini app route not declared",
			slug: "hello-world",
			path: "/apps/hello-world/settings",
		});
		expect(dispatchedRequests).toEqual([]);
	});

	it("retries transient dynamic mini app load failures before returning the route", async () => {
		let calls = 0;
		const { env, dispatchedRequests } = testEnv(helloWorldExtension, () => {
			calls += 1;
			if (calls < 3) {
				throw new Error("Load failed");
			}

			return new Response("<html><body>Ready</body></html>", {
				headers: { "content-type": "text/html" },
			});
		});
		const response = await app.fetch(new Request("http://localhost/apps/hello-world", {
			headers: { accept: "text/html" },
		}), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<html><body>Ready</body></html>");
		expect(dispatchedRequests).toHaveLength(3);
	});

	it("returns a route-scoped failure when a dynamic mini app cannot be loaded", async () => {
		const { env, dispatchedRequests } = testEnv(helloWorldExtension, () => {
			throw new Error("Load failed");
		});
		const response = await app.fetch(new Request("http://localhost/apps/hello-world", {
			headers: { accept: "application/json" },
		}), env);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "Mini app failed to load",
			slug: "hello-world",
			message: "Load failed",
		});
		expect(dispatchedRequests).toHaveLength(4);
	});

	it("does not host-render static fallback pages when dispatch cannot load a Worker", async () => {
		const { env, dispatchedRequests } = testEnv({
			slug: "rss-reader-periodic-sync-update-articles",
			name: "RSS Reader Periodic Sync Update Articles",
			version: "0.1.0",
			description: "Static fallback mini app generated after autonomous app-builder repair attempts failed.",
			status: "dynamic",
			routes: [{
				path: "/apps/rss-reader-periodic-sync-update-articles",
				mode: "worker-page",
				label: "RSS Reader Periodic Sync Update Articles",
			}],
			commands: [],
			editorBlocks: [],
			workflows: [],
			bindings: [],
			hostApis: [],
			indexProjections: [],
			deployedScriptName: "enchiridion-rss-reader-periodic-sync-update-articles",
		}, () => {
			throw new Error("Load failed");
		});
		const response = await app.fetch(new Request("http://localhost/apps/rss-reader-periodic-sync-update-articles", {
			headers: { accept: "text/html" },
		}), env);
		const body = await response.text();

		expect(response.status).toBe(502);
		expect(response.headers.get("x-enchiridion-fallback-renderer")).toBeNull();
		expect(body).toContain("rss-reader-periodic-sync-update-articles failed to load");
		expect(body).toContain("Load failed");
		expect(body).not.toContain("Enchiridion fallback mini app");
		expect(dispatchedRequests).toHaveLength(4);
	});

	it("returns a route-scoped 404 for missing exact mini app routes", async () => {
		const { env } = testEnv(null);
		const response = await app.fetch(new Request("http://localhost/apps/missing"), env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Mini app route not found", slug: "missing" });
	});

	it("does not dispatch disabled mini apps even when a deployed script remains", async () => {
		const { env, dispatchedRequests } = testEnv({
			...helloWorldExtension,
			status: "disabled",
		});
		const response = await app.fetch(new Request("http://localhost/apps/hello-world"), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Mini app is disabled", slug: "hello-world" });
		expect(dispatchedRequests).toEqual([]);
	});

	it("mints host-context tokens only for scopes declared by the target mini app", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "hello-world",
				scopes: ["resource-index:read", "resource-index:read"],
				context: { path: "/apps/hello-world" },
			}),
		}), env);
		const body = await response.json() as { token: string };
		const payload = await verifyHostContext(body.token, "test-secret");

		expect(response.status).toBe(200);
		expect(payload).toMatchObject({
			app: "hello-world",
			scopes: ["resource-index:read"],
			context: { path: "/apps/hello-world" },
		});
	});

	it("rejects host-context token minting without an app route path", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "hello-world",
				scopes: ["resource-index:read"],
			}),
		}), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context path must stay under app route",
			app: "hello-world",
		});
	});

	it("rejects host-context token minting for another app route path", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "hello-world",
				scopes: ["resource-index:read"],
				context: { path: "/apps/bookmarks" },
			}),
		}), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context path must stay under app route",
			app: "hello-world",
		});
	});

	it("rejects host-context token minting for undeclared app route paths", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "hello-world",
				scopes: ["resource-index:read"],
				context: { path: "/apps/hello-world/settings" },
			}),
		}), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context path must match a declared app route",
			app: "hello-world",
		});
	});

	it("rejects host-context token minting for unknown apps", async () => {
		const { env } = testEnv(null);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "missing",
				scopes: ["resource-index:read"],
			}),
		}), env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Host context app not found", app: "missing" });
	});

	it("rejects host-context token minting for undeclared scopes", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/api/host-context", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app: "hello-world",
				scopes: ["resource-index:read", "notes:write"],
			}),
		}), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Requested host-context scopes are not declared by app",
			app: "hello-world",
			scopes: ["notes:write"],
		});
	});
});

function testEnv(
	extension: RegisteredExtension | null,
	miniAppResponse?: (request: Request) => Response | Promise<Response>,
): { env: Env; dispatchedRequests: Request[] } {
	const dispatchedRequests: Request[] = [];
	const env = {
		DB: createFakeD1(extension),
		HOST_SIGNING_SECRET: "test-secret",
		ASSETS: {
			async fetch() {
				return new Response("asset-shell", {
					headers: { "content-type": "text/html" },
				});
			},
		},
		MINI_APP_DISPATCHER: {
			get(scriptName: string) {
				expect(scriptName).toBe(extension?.deployedScriptName ?? "enchiridion-hello-world");
				return {
					async fetch(request: Request) {
						dispatchedRequests.push(request);
						return miniAppResponse?.(request) ?? new Response(`mini-app:${new URL(request.url).pathname}`, {
							headers: { "content-type": "text/html" },
						});
					},
				};
			},
		},
	} as unknown as Env;

	return { env, dispatchedRequests };
}

function createFakeD1(extension: RegisteredExtension | null): D1Database {
	return {
		prepare(sql: string) {
			let params: unknown[] = [];
			const statement = {
				bind(...values: unknown[]) {
					params = values;
					return statement;
				},
				async run() {
					return { success: true };
				},
				async first() {
					if (/SELECT COUNT\(\*\) AS count FROM (bookmarks|projects)/.test(sql)) {
						return { count: 1 };
					}
					if (/SELECT \* FROM extension_manifests WHERE slug = \?/.test(sql)) {
						return extension && params[0] === extension.slug ? extensionRow(extension) : null;
					}
					return null;
				},
				async all() {
					return { results: [] };
				},
			};
			return statement;
		},
	} as unknown as D1Database;
}

function extensionRow(extension: RegisteredExtension) {
	return {
		slug: extension.slug,
		manifest_json: JSON.stringify(extension),
		status: extension.status,
		deployed_script_name: extension.deployedScriptName,
		created_at: "2026-06-18T00:00:00.000Z",
		updated_at: "2026-06-18T00:00:00.000Z",
	};
}

function scheduledWorkflowRow(enabled: number) {
	return {
		id: "rss-reader:refresh-feeds",
		extension_slug: "rss-reader",
		name: "RSS Reader: Refresh feeds",
		cron: "*/15 * * * *",
		workflow_name: "run-mini-app-workflow",
		payload_json: JSON.stringify({
			app: "rss-reader",
			requiredHostApis: ["resource-index:write"],
			workflowId: "refresh-feeds",
		}),
		enabled,
		last_run_at: null,
		created_at: "2026-06-18T12:00:00.000Z",
		updated_at: "2026-06-18T12:05:00.000Z",
	};
}
