import { describe, expect, it } from "vitest";
import { formatAgentError, formatAgentResult, formatMiniAppResult } from "../src/lib/agent-format";
import type { MiniAppIntent } from "../src/lib/mini-app-requests";

const createIntent: MiniAppIntent = {
	shouldBuild: true,
	operation: "create",
};

describe("agent result formatting", () => {
	it("formats ordinary deployed mini apps with absolute routes", () => {
		expect(formatMiniAppResult({
			status: "deployed",
			operation: "create",
			slug: "bookmarks",
			deployed: true,
			routeUrl: "/apps/bookmarks",
		}, createIntent, "https://enchiridion.rawkodeacademy.workers.dev")).toBe(
			"deployed: bookmarks deployed. https://enchiridion.rawkodeacademy.workers.dev/apps/bookmarks",
		);
	});

	it("makes fallback deployments explicit in the transcript", () => {
		expect(formatMiniAppResult({
			status: "deployed",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: true,
			fallback: true,
			routeUrl: "/apps/kubernetes-topology-spread-constraints",
			message: "LLM generation failed; deployed a static fallback mini app.",
			attempts: [
				{ attempt: 1, status: "validation_failed", message: "Smoke test failed with 500: Load failed" },
			],
		}, createIntent, "https://enchiridion.rawkodeacademy.workers.dev")).toBe(
			"deployed: kubernetes-topology-spread-constraints fallback deployed. https://enchiridion.rawkodeacademy.workers.dev/apps/kubernetes-topology-spread-constraints LLM generation failed; deployed a static fallback mini app. Attempt: #1 validation_failed Smoke test failed with 500: Load failed",
		);
	});

	it("makes fallback terminal failures explicit", () => {
		expect(formatMiniAppResult({
			status: "fallback_validation_failed",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: false,
			message: "Smoke test failed with 200: primary route must return text/html",
		}, createIntent)).toBe(
			"fallback_validation_failed: kubernetes-topology-spread-constraints. Fallback mini app was not activated. Smoke test failed with 200: primary route must return text/html",
		);
	});

	it("keeps validation failures clear when no candidate was activated", () => {
		expect(formatMiniAppResult({
			status: "validation_failed",
			operation: "create",
			slug: "hello-world",
			deployed: false,
			message: "Smoke test failed with 500: Load failed",
			attempts: [
				{ attempt: 1, status: "validation_failed", message: "Smoke test failed with 500: Load failed", cleanup: "Mini app Worker candidate removed." },
			],
		}, createIntent)).toBe(
			"validation_failed: hello-world. Candidate Worker failed smoke testing and was not activated. Smoke test failed with 500: Load failed Attempt: #1 validation_failed Smoke test failed with 500: Load failed cleanup: Mini app Worker candidate removed.",
		);
	});

	it("renders structured issue objects without object string placeholders", () => {
		expect(formatMiniAppResult({
			status: "rejected",
			operation: "create",
			slug: "bad-app",
			deployed: false,
			issues: [{ message: "Manifest route is unsafe." }],
			attempts: [{ attempt: 1, status: "rejected", issues: [{ error: "Load failed body rejected." }] }],
		}, createIntent)).toBe(
			"rejected: bad-app. Manifest route is unsafe. Attempt: #1 rejected Load failed body rejected.",
		);
	});

	it("unwraps nested agent text before falling back to JSON", () => {
		expect(formatAgentResult({ result: { content: [{ text: "First" }, { message: "Second" }] } })).toBe("First\nSecond");
		expect(formatAgentResult({ ok: true })).toBe("{\"ok\":true}");
	});

	it("formats structured agent errors", () => {
		expect(formatAgentError({ error: "Workflow failed" }, "fallback")).toBe("Workflow failed");
		expect(formatAgentError(null, "fallback")).toBe("fallback");
	});
});
