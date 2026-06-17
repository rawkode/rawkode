import { describe, expect, it } from "vitest";
import { isRepairableDeploymentFailure, validateGeneratedMiniApp } from "../src/workflows/generate-mini-app";
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

function generated(manifest: ExtensionManifest, workerSource = "export default { fetch() { return new Response('<h1>Hello</h1>', { headers: { 'content-type': 'text/html' } }) } }") {
	return {
		manifest,
		workerSource,
		deploymentNotes: "Generated for test.",
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

	it("does not retry missing Cloudflare configuration failures", () => {
		expect(isRepairableDeploymentFailure("Cloudflare account ID, API token, or dispatch namespace is not configured.")).toBe(false);
		expect(isRepairableDeploymentFailure("Cloudflare upload failed with 400: module parse error")).toBe(true);
	});
});
