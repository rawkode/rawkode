import { describe, expect, it } from "vitest";
import app from "../src/app";
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

	it("dispatches nested dynamic mini app routes", async () => {
		const { env } = testEnv(helloWorldExtension);
		const response = await app.fetch(new Request("http://localhost/apps/hello-world/settings"), env);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("mini-app:/apps/hello-world/settings");
	});

	it("returns a route-scoped 404 for missing exact mini app routes", async () => {
		const { env } = testEnv(null);
		const response = await app.fetch(new Request("http://localhost/apps/missing"), env);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Mini app route not found", slug: "missing" });
	});
});

function testEnv(extension: RegisteredExtension | null): { env: Env; dispatchedRequests: Request[] } {
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
						return new Response(`mini-app:${new URL(request.url).pathname}`, {
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
