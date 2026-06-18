import { describe, expect, it } from "vitest";
import { formatAgentBuildMeta, generateMiniAppWorkflowName, retryModeForAgentBlock } from "../src/lib/agent-retry";

describe("agent retry helpers", () => {
	it("retries durable mini app build failures as builds", () => {
		expect(retryModeForAgentBlock({
			app: "agent",
			block: "error",
			operation: "create",
			prompt: "rss reader",
			workflowName: generateMiniAppWorkflowName,
		})).toBe("build");
	});

	it("preserves update retries when the failed operation was an update", () => {
		expect(retryModeForAgentBlock({
			app: "agent",
			block: "error",
			operation: "update",
			prompt: "make hello world blue",
			targetSlug: "hello-world",
			workflowName: generateMiniAppWorkflowName,
		})).toBe("update");
	});

	it("offers a build retry for legacy untracked running requests", () => {
		expect(retryModeForAgentBlock({
			app: "agent",
			block: "request",
			isUntrackedMiniAppBuild: true,
			prompt: "RSS Reader",
		})).toBe("build");
	});

	it("does not add retry actions to non-agent blocks", () => {
		expect(retryModeForAgentBlock({
			app: "bookmarks",
			block: "bookmark-reference",
			prompt: "https://rawkode.academy",
		})).toBeNull();
	});

	it("formats build metadata without object placeholders", () => {
		expect(formatAgentBuildMeta({
			app: "agent",
			block: "error",
			buildDeadlineAt: "2026-06-18T13:48:47.335Z",
			buildId: "build-1",
			runId: "run_1",
		}, () => "14:48 BST")).toBe("build build-1 · submission run_1 · deadline 14:48 BST");
	});
});
