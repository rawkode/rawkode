import { describe, expect, it } from "vitest";
import {
	candidateScriptNameForManifest,
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
	it("uses stable and candidate script names for mini app deployments", () => {
		expect(scriptNameForManifest(manifest)).toBe("enchiridion-hello-world");
		expect(candidateScriptNameForManifest(manifest)).toMatch(/^enchiridion-hello-world-[a-f0-9]{8}$/);
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
});
