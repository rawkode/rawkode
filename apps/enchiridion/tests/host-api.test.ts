import { describe, expect, it } from "vitest";
import app from "../src/app";
import { signHostContext } from "../src/lib/host-context";
import type { Env } from "../src/lib/types";

describe("host API routes", () => {
	it("allows scoped mini app host-context tokens to search the resource index without browser auth", async () => {
		const token = await signHostContext({
			app: "search-app",
			scopes: ["resource-index:read"],
			expiresAt: Date.now() + 60_000,
			context: { path: "/apps/search-app" },
		}, "configured-secret");
		const env = hostApiEnv([{
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
		}]);

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
		const env = hostApiEnv([]);

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { "x-enchiridion-host-context": token } },
		), env);
		const body = await response.json() as { error: string };

		expect(response.status).toBe(403);
		expect(body.error).toContain("resource-index:read");
	});

	it("rejects host API requests that only have browser auth", async () => {
		const env = hostApiEnv([]);

		const response = await app.fetch(new Request(
			"https://enchiridion.rawkodeacademy.workers.dev/api/host/resource-index/search?q=topology",
			{ headers: { authorization: `Basic ${btoa("rawkode:secret-password")}` } },
		), env);
		const body = await response.json() as { error: string };

		expect(response.status).toBe(401);
		expect(body.error).toBe("Missing host context token");
	});
});

function hostApiEnv(rows: unknown[]): Env {
	return {
		HOST_SIGNING_SECRET: "configured-secret",
		ENCHIRIDION_PASSWORD: "secret-password",
		DB: {
			prepare() {
				return {
					bind() {
						return {
							async all() {
								return { results: rows };
							},
						};
					},
					async all() {
						return { results: rows };
					},
				};
			},
		},
	} as unknown as Env;
}
