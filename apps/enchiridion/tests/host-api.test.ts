import { describe, expect, it } from "vitest";
import app from "../src/app";
import { signHostContext } from "../src/lib/host-context";
import type { Env, RegisteredExtension } from "../src/lib/types";

const searchExtension: RegisteredExtension = {
	slug: "search-app",
	name: "Search App",
	version: "0.1.0",
	description: "Searches the host resource index.",
	status: "dynamic",
	routes: [{ path: "/apps/search-app", mode: "worker-page", label: "Search" }],
	commands: [],
	editorBlocks: [],
	workflows: [],
	bindings: [],
	hostApis: ["resource-index:read"],
	indexProjections: [],
	deployedScriptName: "enchiridion-search-app",
};

const indexingExtension: RegisteredExtension = {
	...searchExtension,
	hostApis: ["resource-index:write"],
	indexProjections: [{ sourceType: "feed-entry", titlePath: "title", summaryPath: "summary", urlPath: "url", tagsPath: "tags" }],
};

describe("host API routes", () => {
	it("allows scoped mini app host-context tokens to search the resource index without browser auth", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({
			rows: [{
				id: "resource-1",
				source_app: "notes",
				source_type: "daily-note",
				source_id: "2026-06-18",
				title: "Kubernetes topology notes",
				summary: "Topology spread constraints draft.",
				url: "/daily/2026-06-18",
				tags_json: JSON.stringify(["kubernetes"]),
				relationships_json: JSON.stringify([]),
				occurred_at: null,
				created_at: "2026-06-18T00:00:00.000Z",
				updated_at: "2026-06-18T00:00:00.000Z",
			}],
		});

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual([expect.objectContaining({
			id: "resource-1",
			title: "Kubernetes topology notes",
			tags: ["kubernetes"],
		})]);
	});

	it("rejects host API requests without the required signed scope", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["notes:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [] });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);
		const body = await response.json() as { error: string };

		expect(response.status).toBe(403);
		expect(body.error).toContain("resource-index:read");
	});

	it("rejects host API requests that only have browser auth", async () => {
		const env = hostApiEnv({ rows: [] });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { authorization: `Basic ${btoa("rawkode:secret-password")}` } },
		), env);
		const body = await response.json() as { error: string };

		expect(response.status).toBe(401);
		expect(body.error).toBe("Missing host context token");
	});

	it("rejects host API requests whose host context is not scoped to the app route", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/bookmarks" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [] });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Host context token path is outside app route scope" });
	});

	it("rejects host API requests whose host context path is not declared by the app", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app/settings" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [] });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context token path is not a declared app route",
			app: "search-app",
		});
	});

	it("rejects host API requests when the token app is no longer registered", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: null });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Host context app not found", app: "search-app" });
	});

	it("rejects host API requests when the token app has been disabled", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({
			rows: [],
			extension: { ...searchExtension, status: "disabled" },
		});

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Host context app is disabled", app: "search-app" });
	});

	it("rejects host API requests when the token app no longer declares the required scope", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({
			rows: [],
			extension: { ...searchExtension, hostApis: [] },
		});

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context app no longer declares required scope",
			app: "search-app",
			scope: "resource-index:read",
		});
	});

	it("allows scoped mini apps to publish app-owned resource records", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:write"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const writes: unknown[][] = [];
		const env = hostApiEnv({ rows: [], extension: indexingExtension, writes });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({
					sourceApp: "other-app",
					sourceType: "feed-entry",
					sourceId: "entry-1",
					title: "Platform update",
					summary: "Cloudflare dispatch notes.",
					url: "/apps/search-app/entries/entry-1",
					tags: ["cloudflare", "dispatch"],
					relationships: [{ type: "source", id: "feed-1" }],
				}),
			},
		), env);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({
			id: "search-app:feed-entry:entry-1",
			sourceApp: "search-app",
			sourceType: "feed-entry",
			sourceId: "entry-1",
			title: "Platform update",
			url: "/apps/search-app/entries/entry-1",
		});
		expect(writes[0]?.[0]).toBe("search-app:feed-entry:entry-1");
		expect(writes[0]?.[1]).toBe("search-app");
		expect(writes[0]?.[7]).toBe(JSON.stringify(["cloudflare", "dispatch"]));
	});

	it("rejects resource record writes without the required signed scope", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: indexingExtension });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({ sourceType: "feed-entry", sourceId: "entry-1", title: "Entry" }),
			},
		), env);

		expect(response.status).toBe(403);
		expect((await response.json() as { error: string }).error).toContain("resource-index:write");
	});

	it("rejects resource record writes for undeclared source types", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:write"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: indexingExtension });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({ sourceType: "unknown", sourceId: "entry-1", title: "Entry" }),
			},
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Resource sourceType is not declared by app",
			app: "search-app",
			sourceType: "unknown",
		});
	});

	it("rejects resource record writes whose host context path is not declared by the app", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:write"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app/settings" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: indexingExtension });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({ sourceType: "feed-entry", sourceId: "entry-1", title: "Entry" }),
			},
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Host context token path is not a declared app route",
			app: "search-app",
		});
	});

	it("rejects resource record writes when the token app has been disabled", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:write"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: { ...indexingExtension, status: "disabled" } });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({ sourceType: "feed-entry", sourceId: "entry-1", title: "Entry" }),
			},
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Host context app is disabled", app: "search-app" });
	});

	it("rejects mini app resource URLs outside the owning app route", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:write"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv({ rows: [], extension: indexingExtension });

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/records",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-enchiridion-host-context": token,
				},
				body: JSON.stringify({
					sourceType: "feed-entry",
					sourceId: "entry-1",
					title: "Entry",
					url: "/apps/other-app/entry-1",
				}),
			},
		), env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Resource URL must stay under app route",
			app: "search-app",
		});
	});
});

function hostApiEnv(input: { rows: unknown[]; extension?: RegisteredExtension | null; writes?: unknown[][] }): Env {
	const extension = input.extension === undefined ? searchExtension : input.extension;
	return {
		HOST_SIGNING_SECRET: "configured-secret",
		ENCHIRIDION_PASSWORD: "secret-password",
		DB: {
			prepare(sql: string) {
				let params: unknown[] = [];
				const statement = {
					bind(...values: unknown[]) {
						params = values;
						return statement;
					},
					async first() {
						if (/SELECT \* FROM extension_manifests WHERE slug = \?/.test(sql)) {
							return extension && params[0] === extension.slug ? extensionRow(extension) : null;
						}
						return null;
					},
					async all() {
						return { results: input.rows };
					},
					async run() {
						if (sql.includes("INSERT INTO resource_index")) {
							input.writes?.push(params);
						}
						return { success: true };
					},
				};
				return statement;
			},
		},
	} as unknown as Env;
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
