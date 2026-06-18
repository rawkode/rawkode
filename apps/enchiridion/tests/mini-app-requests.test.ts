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

	it("routes web app prompts to creation even without create wording", () => {
		const intent = inferMiniAppIntent("Web app Kubernetes how to for topology spread constraints", [helloWorld]);

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
		expect(prompt).toContain("/api/host/resource-index/search");
		expect(prompt).toContain("x-enchiridion-host-context");
		expect(prompt).toContain("Only call global fetch");
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
		expect(prompt).toContain("hostApis: [\"resource-index:read\"]");
		expect(prompt).toContain("x-enchiridion-host-context");
		expect(prompt).toContain("Only call global fetch");
		expect(prompt).toContain("export default");
	});
});
