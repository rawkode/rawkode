import { describe, expect, it } from "vitest";
import app from "../src/app";
import { verifyHostContext } from "../src/lib/host-context";
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
				expect(scriptName).toBe("enchiridion-hello-world");
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
