import { describe, expect, it } from "vitest";
import {
	buildMiniAppRepairPrompt,
	buildMiniAppGenerationPrompt,
	findReferencedExtension,
	inferMiniAppIntent,
	summarizeMiniApp,
} from "../src/lib/mini-app-requests";
import type { RegisteredExtension } from "../src/lib/types";

const helloWorld: RegisteredExtension = {
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
	deployedScriptName: "enchiridion-hello-world",
};

describe("mini app request helpers", () => {
	it("routes update prompts to the existing mini app", () => {
		const intent = inferMiniAppIntent("Update hello world app to have blue background", [helloWorld]);

		expect(intent).toEqual({
			shouldBuild: true,
			operation: "update",
			targetSlug: "hello-world",
		});
	});

	it("treats forced build prompts that name an existing app as updates", () => {
		const intent = inferMiniAppIntent("Make hello world app background blue", [helloWorld], true);

		expect(intent).toEqual({
			shouldBuild: true,
			operation: "update",
			targetSlug: "hello-world",
		});
	});

	it("keeps explicit new app prompts as creates even when they mention an existing app", () => {
		const intent = inferMiniAppIntent("Create a new app like hello world", [helloWorld], true);

		expect(intent).toEqual({
			shouldBuild: true,
			operation: "create",
		});
	});

	it("uses make as a create signal when no existing app is referenced", () => {
		const intent = inferMiniAppIntent("Make a simple habit tracker app", [helloWorld]);

		expect(intent).toEqual({
			shouldBuild: true,
			operation: "create",
		});
	});

	it("routes web app prompts to creation even without create wording", () => {
		const intent = inferMiniAppIntent("Web app Kubernetes how to for topology spread constraints", [helloWorld]);

		expect(intent.shouldBuild).toBe(true);
		expect(intent.operation).toBe("create");
	});

	it("routes web tutorial prompts to creation even without the app noun", () => {
		const intent = inferMiniAppIntent("Simple web tutorial to learn ML rank for training jobs", [helloWorld]);

		expect(intent.shouldBuild).toBe(true);
		expect(intent.operation).toBe("create");
	});

	it("leaves ordinary chat in chat mode", () => {
		const intent = inferMiniAppIntent("What should I work on today?", [helloWorld]);

		expect(intent.shouldBuild).toBe(false);
	});

	it("finds mini apps by slug or display name", () => {
		expect(findReferencedExtension("change hello world", [helloWorld])?.slug).toBe("hello-world");
		expect(findReferencedExtension("change hello-world", [helloWorld])?.slug).toBe("hello-world");
	});

	it("builds update prompts with installed app inventory and target manifest", () => {
		const prompt = buildMiniAppGenerationPrompt({
			userPrompt: "Update hello world app to have blue background",
			operation: "update",
			installedExtensions: [helloWorld],
			targetExtension: helloWorld,
		});

		expect(prompt).toContain("Request operation: update");
		expect(prompt).toContain('"slug": "hello-world"');
		expect(prompt).toContain("keep the target manifest slug exactly the same");
		expect(prompt).toContain("self-contained JavaScript module");
		expect(prompt).toContain("Do not return generic fallback bodies");
		expect(prompt).toContain("Keep each dynamic mini app response at or below 262144 bytes");
		expect(prompt).toContain("/api/host/resource-index/search");
		expect(prompt).toContain("x-enchiridion-host-context");
		expect(prompt).toContain("Declare hostApis only");
		expect(prompt).toContain("Only call global fetch");
		expect(prompt).toContain("Call fetch directly");
		expect(prompt).toContain("same fetch options object");
		expect(prompt).toContain("CSP sandbox");
		expect(prompt).toContain("server-rendered HTML and links");
		expect(prompt).toContain("Content-Encoding headers");
		expect(prompt).toContain("Refresh headers");
		expect(prompt).toContain("meta refresh tags");
		expect(prompt).toContain("Never render, log, redirect with, or otherwise expose the x-enchiridion-host-context token");
		expect(summarizeMiniApp(helloWorld).deployedScriptName).toBe("enchiridion-hello-world");
	});

	it("builds repair prompts with the smoke-test failure and previous source", () => {
		const prompt = buildMiniAppRepairPrompt({
			userPrompt: "Update hello world app to have blue background",
			operation: "update",
			failureMessage: "Smoke test failed with 500: Load failed",
			manifest: helloWorld,
			workerSource: "export default { fetch() { return new Response('bad') } }",
		});

		expect(prompt).toContain("failed Enchiridion validation, deployment, or route smoke testing");
		expect(prompt).toContain("Smoke test failed with 500: Load failed");
		expect(prompt).toContain("Keep the manifest slug exactly as hello-world");
		expect(prompt).toContain("Do not return generic fallback bodies");
		expect(prompt).toContain("Keep each dynamic mini app response at or below 262144 bytes");
		expect(prompt).toContain("hostApis: [\"resource-index:read\"]");
		expect(prompt).toContain("x-enchiridion-host-context");
		expect(prompt).toContain("Declare hostApis only");
		expect(prompt).toContain("Only call global fetch");
		expect(prompt).toContain("Call fetch directly");
		expect(prompt).toContain("same fetch options object");
		expect(prompt).toContain("CSP sandbox");
		expect(prompt).toContain("server-rendered HTML and links");
		expect(prompt).toContain("Content-Encoding headers");
		expect(prompt).toContain("Refresh headers");
		expect(prompt).toContain("meta refresh tags");
		expect(prompt).toContain("Never render, log, redirect with, or otherwise expose the x-enchiridion-host-context token");
		expect(prompt).toContain("export default");
	});
});
