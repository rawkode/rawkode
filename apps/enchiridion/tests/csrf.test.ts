import { describe, expect, it } from "vitest";
import app from "../src/app";
import type { Env } from "../src/lib/types";

describe("browser write request origin checks", () => {
	it("rejects unsafe cross-origin writes before authentication", async () => {
		const response = await app.fetch(new Request("https://enchiridion.rawkodeacademy.workers.dev/api/daily-notes/2026-06-18", {
			method: "PUT",
			headers: {
				authorization: `Basic ${btoa("rawkode:secret-password")}`,
				"content-type": "application/json",
				origin: "https://attacker.example",
			},
			body: JSON.stringify({ documentJson: { type: "doc" } }),
		}), {} as Env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Cross-origin write requests are not allowed" });
	});

	it("rejects unsafe writes with browser fetch metadata from another site", async () => {
		const response = await app.fetch(new Request("https://enchiridion.rawkodeacademy.workers.dev/api/apps/bookmarks/bookmarks", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"sec-fetch-site": "cross-site",
			},
			body: JSON.stringify({ title: "Kubernetes", url: "https://kubernetes.io/" }),
		}), {} as Env);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "Cross-origin write requests are not allowed" });
	});

	it("allows same-origin unsafe writes to continue to normal authentication", async () => {
		const response = await app.fetch(new Request("https://enchiridion.rawkodeacademy.workers.dev/api/daily-notes/2026-06-18", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				origin: "https://enchiridion.rawkodeacademy.workers.dev",
			},
			body: JSON.stringify({ documentJson: { type: "doc" } }),
		}), {} as Env);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Basic realm="Enchiridion", charset="UTF-8"');
	});

	it("allows non-browser unsafe requests without origin metadata to continue to normal authentication", async () => {
		const response = await app.fetch(new Request("https://enchiridion.rawkodeacademy.workers.dev/api/apps/projects/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Enchiridion" }),
		}), {} as Env);

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Basic realm="Enchiridion", charset="UTF-8"');
	});
});
