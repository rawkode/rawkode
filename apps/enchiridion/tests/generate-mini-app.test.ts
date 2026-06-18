import { describe, expect, it } from "vitest";
import {
	createFallbackMiniAppCandidate,
	isRepairableDeploymentFailure,
	validateGeneratedMiniApp,
} from "../src/workflows/generate-mini-app";
import type { ExtensionManifest, RegisteredExtension } from "../src/lib/types";

const baseManifest: ExtensionManifest = {
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

const registeredHelloWorld: RegisteredExtension = {
	...baseManifest,
	deployedScriptName: "enchiridion-hello-world",
};

function generated(
	manifest: ExtensionManifest,
	workerSource = "export default { fetch() { return new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html' } }) } }",
	deploymentNotes = "Generated for test.",
) {
	return {
		manifest,
		workerSource,
		deploymentNotes,
	};
}

describe("generate mini app candidate validation", () => {
	it("rejects autonomous binding requests before Cloudflare upload", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				bindings: [{ type: "kv_namespace", name: "HELLO_CACHE", purpose: "Cache generated pages." }],
			}),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("requires_binding_provisioning");
		expect(result.issues[0]).toContain("autonomous deploy cannot provision isolated bindings yet");
	});

	it("allows binding requests when autonomous deployment is disabled", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				bindings: [{ type: "kv_namespace", name: "HELLO_CACHE", purpose: "Cache generated pages." }],
			}),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: false,
		});

		expect(result.ok).toBe(true);
	});

	it("rejects create operations that collide with an installed mini app", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(baseManifest),
			installedExtensions: [registeredHelloWorld],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("manifest.slug: hello-world already exists; use update instead");
	});

	it("rejects update operations that change the target slug", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				slug: "hello-world-two",
				routes: [{ path: "/apps/hello-world-two", mode: "worker-page", label: "Hello World Two" }],
			}),
			installedExtensions: [registeredHelloWorld],
			operation: "update",
			targetExtension: registeredHelloWorld,
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("manifest.slug: update must keep target slug hello-world");
	});

	it("rejects generated workers that render generic load failures", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				"export default { fetch() { return new Response('Load failed', { status: 500 }) } }",
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: primary route must render useful HTML instead of a generic Load failed response");
	});

	it("rejects oversized generated workers before Cloudflare upload", () => {
		const workerSource = [
			"export default { fetch() { return new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html' } }) } }",
			" ".repeat(65 * 1024),
		].join("\n");
		const result = validateGeneratedMiniApp({
			generated: generated(baseManifest, workerSource),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Worker source exceeds 65536 bytes");
	});

	it("rejects oversized generated deployment notes", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(baseManifest, undefined, "x".repeat(2_001)),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("deploymentNotes: must be 2000 characters or fewer");
	});

	it("rejects oversized generated manifest route lists", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				routes: Array.from({ length: 9 }, (_, index) => ({
					path: `/apps/hello-world/${index}`,
					mode: "worker-page",
					label: `Route ${index}`,
				})),
			}),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("manifest.routes: generated mini apps may declare at most 8 routes");
	});

	it("rejects generated workers that depend on unavailable runtime bindings", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				"export default { fetch(request, env) { return env.ASSETS.fetch(request) } }",
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: autonomous workers cannot read env bindings; declare host APIs instead");
	});

	it("rejects generated workers that access bindings through bracket notation", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				"export default { fetch(request, env) { return env['DB'].prepare('SELECT 1').first() } }",
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: autonomous workers cannot read env bindings; declare host APIs instead");
	});

	it("rejects generated workers with dynamic code or background side effects", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`
export default {
	fetch(request, env, ctx) {
		ctx.waitUntil(Promise.resolve());
		const render = new Function("return '<h1>Hello</h1>'");
		setTimeout(() => {}, 1);
		return new Response(render(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: autonomous workers cannot use execution context side effects");
		expect(result.issues).toContain("workerSource: generated Workers cannot evaluate dynamic code");
		expect(result.issues).toContain("workerSource: generated Workers cannot schedule background timers");
	});

	it("rejects generated workers that use undeclared platform storage or sockets", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`
export default {
	async fetch() {
		await caches.default.match("https://example.test/");
		const socket = new WebSocket("wss://example.test/");
		return new Response(String(socket), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: autonomous workers cannot use undeclared cache storage");
		expect(result.issues).toContain("workerSource: generated Workers cannot open network sockets");
	});

	it("allows declared host API reads when the worker forwards host context", () => {
		const workerSource = `
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		url.searchParams.set("q", "kubernetes");
		url.searchParams.set("limit", "5");
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		const resources = await response.json();
		return new Response(\`<html><body><h1>Results</h1><pre>\${JSON.stringify(resources)}</pre></body></html>\`, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
}`;

		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				hostApis: ["resource-index:read"],
			}, workerSource),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(true);
	});

	it("allows inline declared host API fetch targets", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				hostApis: ["resource-index:read"],
			}, `
export default {
	async fetch(request) {
		const response = await fetch(new URL("/api/host/resource-index/search", request.url), {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(true);
	});

	it("rejects generated workers that call fetch without a host API", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`
export default {
	async fetch(request) {
		const url = new URL("/apps/hello-world/data", request.url);
		const response = await fetch(url);
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers may only call fetch for declared host APIs");
	});

	it("rejects generated workers that fetch a non-host-api variable even when a host API URL exists", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const hostUrl = new URL("/api/host/resource-index/search", request.url);
		const localUrl = new URL("/apps/hello-world/data", request.url);
		const response = await fetch(localUrl, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers may only call fetch for declared host APIs");
	});

	it("rejects generated workers that rewrite host API URL paths before fetching", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		url.pathname = "/apps/hello-world/data";
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers cannot rewrite host API URL paths before fetch");
	});

	it("rejects generated workers that fetch reassigned host API variables", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		let url = new URL("/api/host/resource-index/search", request.url);
		url = new URL("/apps/hello-world/data", request.url);
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers may only call fetch for declared host APIs");
	});

	it("rejects generated workers that call globalThis.fetch", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		const response = await globalThis.fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers must call fetch directly for declared host APIs");
	});

	it("rejects generated workers that alias fetch", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		const requestFetch = fetch;
		const response = await requestFetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers must call fetch directly for declared host APIs");
	});

	it("rejects generated workers that use fetch.call", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		const response = await fetch.call(null, url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers must call fetch directly for declared host APIs");
	});

	it("rejects generated workers that mutate URL origins before fetching", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		url.hostname = "example.test";
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers cannot mutate URL origins before fetch");
	});

	it("rejects host API reads that are not declared by the manifest", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: /api/host/resource-index/search requires manifest.hostApis to include resource-index:read");
	});

	it("rejects host API reads that do not forward host context", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/resource-index/search", request.url);
		const response = await fetch(url);
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: host API calls must forward the incoming x-enchiridion-host-context header");
	});

	it("rejects browser-authenticated host routes from generated workers", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`
export default {
	async fetch(request) {
		const url = new URL("/api/search", request.url);
		return new Response(String(url), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: generated Workers must use /api/host/* for host APIs instead of browser-authenticated APIs");
	});

	it("rejects unsupported host API paths", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				{
					...baseManifest,
					hostApis: ["resource-index:read"],
				},
				`
export default {
	async fetch(request) {
		const url = new URL("/api/host/notes", request.url);
		const response = await fetch(url, {
			headers: { "x-enchiridion-host-context": request.headers.get("x-enchiridion-host-context") ?? "" },
		});
		return new Response(await response.text(), { headers: { "content-type": "text/html" } });
	},
}`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: unsupported host API path /api/host/notes");
	});

	it("allows static outbound links in generated tutorial pages", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`export default { fetch() { return new Response('<html><body><a href="https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/">Docs</a></body></html>', { headers: { 'content-type': 'text/html' } }) } }`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(true);
	});

	it("rejects generated workers that hard-code another mini app route", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`export default { fetch() { return Response.redirect("https://example.local/apps/bookmarks", 302) } }`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: app routes must stay under /apps/hello-world: /apps/bookmarks");
	});

	it("allows generated workers to reference nested routes under their own app", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`export default { fetch() { return new Response('<html><body><a href="/apps/hello-world/settings">Settings</a></body></html>', { headers: { 'content-type': 'text/html' } }) } }`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(true);
	});

	it("rejects generated workers that only share the app route prefix", () => {
		const result = validateGeneratedMiniApp({
			generated: generated(
				baseManifest,
				`export default { fetch() { return new Response('<html><body><a href="/apps/hello-worldish">Wrong app</a></body></html>', { headers: { 'content-type': 'text/html' } }) } }`,
			),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("workerSource: app routes must stay under /apps/hello-world: /apps/hello-worldish");
	});

	it("requires an autonomous mini app route that can be smoke tested", () => {
		const result = validateGeneratedMiniApp({
			generated: generated({
				...baseManifest,
				routes: [],
			}),
			installedExtensions: [],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toContain("routes: autonomous mini apps must expose at least one worker-page route");
	});

	it("creates a valid static fallback mini app from a failed app prompt", () => {
		const candidate = createFallbackMiniAppCandidate({
			userPrompt: "Web app Kubernetes how to for topology spread constraints",
			installedExtensions: [registeredHelloWorld],
		});
		const result = validateGeneratedMiniApp({
			generated: candidate,
			installedExtensions: [registeredHelloWorld],
			operation: "create",
			autonomousDeploy: true,
		});

		expect(candidate.manifest.slug).toBe("kubernetes-topology-spread-constraints");
		expect(candidate.manifest.routes).toEqual([expect.objectContaining({
			path: "/apps/kubernetes-topology-spread-constraints",
			mode: "worker-page",
		})]);
		expect(candidate.manifest.bindings).toEqual([]);
		expect(candidate.manifest.hostApis).toEqual([]);
		expect(candidate.workerSource).toContain("export default");
		expect(candidate.workerSource).toContain("text/html; charset=utf-8");
		expect(result.ok).toBe(true);
	});

	it("avoids slug collisions when creating fallback mini apps", () => {
		const candidate = createFallbackMiniAppCandidate({
			userPrompt: "Hello world",
			installedExtensions: [registeredHelloWorld],
		});

		expect(candidate.manifest.slug).toBe("hello-world-2");
		expect(candidate.manifest.routes[0]?.path).toBe("/apps/hello-world-2");
	});

	it("does not retry missing Cloudflare configuration failures", () => {
		expect(isRepairableDeploymentFailure("Cloudflare account ID, API token, or dispatch namespace is not configured.")).toBe(false);
		expect(isRepairableDeploymentFailure("Cloudflare upload failed with 400: module parse error")).toBe(true);
	});
});
