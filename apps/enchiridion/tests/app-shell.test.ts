import { describe, expect, it } from "vitest";
import app from "../src/app";
import type { Env } from "../src/lib/types";

describe("app shell routing", () => {
	it("serves the authenticated root path without triggering the index.html canonical redirect", async () => {
		const assetPaths: string[] = [];
		const env = shellEnv(assetPaths);
		const response = await app.fetch(new Request("https://enchiridion.rawkodeacademy.workers.dev/", {
			headers: { authorization: `Basic ${btoa("enchiridion:secret-password")}` },
		}), env);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(await response.text()).toBe("asset:/");
		expect(assetPaths).toEqual(["/"]);
	});
});

function shellEnv(assetPaths: string[]): Env {
	return {
		ENCHIRIDION_PASSWORD: "secret-password",
		ASSETS: {
			async fetch(request: Request) {
				const path = new URL(request.url).pathname;
				assetPaths.push(path);
				if (path === "/index.html") {
					return Response.redirect("https://enchiridion.rawkodeacademy.workers.dev/", 301);
				}

				return new Response(`asset:${path}`, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		},
		DB: fakeD1(),
	} as unknown as Env;
}

function fakeD1(): D1Database {
	return {
		prepare(sql: string) {
			const statement = {
				bind() {
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
					return { results: [] };
				},
			};
			return statement;
		},
	} as unknown as D1Database;
}
