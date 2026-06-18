import { describe, expect, it } from "vitest";
import { formatAgentError, formatAgentResult, formatMiniAppBuildError, formatMiniAppResult } from "../src/lib/agent-format";
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

	it("makes pending dispatch registrations explicit", () => {
		expect(formatMiniAppResult({
			status: "deployed_pending",
			operation: "create",
			slug: "kubernetes-topology-spread-constraints",
			deployed: true,
			fallback: true,
			routeUrl: "/apps/kubernetes-topology-spread-constraints",
			message: "LLM generation failed; registered a static fallback mini app, but dispatch did not become ready during smoke testing: Load failed",
			validationAttempts: [
				{ attempt: 1, status: "failed", message: "Load failed" },
				{ attempt: 4, status: "failed", message: "Load failed" },
			],
		}, createIntent, "https://enchiridion.rawkodeacademy.workers.dev")).toBe(
			"deployed_pending: kubernetes-topology-spread-constraints fallback route registered pending dispatch validation. https://enchiridion.rawkodeacademy.workers.dev/apps/kubernetes-topology-spread-constraints LLM generation failed; registered a static fallback mini app, but dispatch did not become ready during smoke testing: Load failed Validation attempts: #1 failed Load failed | #4 failed Load failed",
		);
	});

	it("makes deferred updates explicit in the transcript", () => {
		expect(formatMiniAppResult({
			status: "update_deferred",
			operation: "update",
			slug: "hello-world",
			deployed: false,
			activeRoutePreserved: true,
			routeUrl: "/apps/hello-world",
			message: "Update candidate was uploaded but not activated because dispatch did not become ready during smoke testing: Load failed",
			validationAttempts: [
				{ attempt: 1, status: "failed", message: "Load failed" },
				{ attempt: 4, status: "failed", message: "Load failed" },
			],
		}, { shouldBuild: true, operation: "update", targetSlug: "hello-world" }, "https://enchiridion.rawkodeacademy.workers.dev")).toBe(
			"update_deferred: hello-world update candidate was not activated; active route preserved. https://enchiridion.rawkodeacademy.workers.dev/apps/hello-world Update candidate was uploaded but not activated because dispatch did not become ready during smoke testing: Load failed Validation attempts: #1 failed Load failed | #4 failed Load failed",
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
			validationAttempts: [
				{ attempt: 1, status: "failed", message: "Load failed" },
			],
		}, createIntent)).toBe(
			"validation_failed: hello-world. Candidate Worker failed smoke testing and was not activated. Smoke test failed with 500: Load failed Attempt: #1 validation_failed Smoke test failed with 500: Load failed cleanup: Mini app Worker candidate removed. Validation attempt: #1 failed Load failed",
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

	it("adds deployment context to bare mini app build load failures", () => {
		expect(formatMiniAppBuildError({ message: "Load failed" }, "fallback")).toBe(
			"Mini app build workflow failed before returning a deployment result: Load failed. No mini app was activated.",
		);
		expect(formatMiniAppBuildError({ error: "Dispatch upload failed" }, "fallback")).toBe("Dispatch upload failed");
	});
});
