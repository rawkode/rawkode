import { describe, expect, it } from "vitest";
import { buildPromptRefinementMessages, refineAgentPrompt } from "../src/lib/prompt-refinement";
import type { CloudflareAIBinding } from "../src/lib/types";

describe("prompt refinement", () => {
	it("builds use-case aware prompt rewriting messages", () => {
		const messages = buildPromptRefinementMessages({
			mode: "build",
			prompt: "rss reader with cron",
			targetSlug: "rss-reader",
		});

		expect(messages[0]?.content).toContain("Return only the rewritten prompt text");
		expect(messages[1]?.content).toContain("build a new Enchiridion mini app");
		expect(messages[1]?.content).toContain("Target mini app: rss-reader");
		expect(messages[1]?.content).toContain("Original prompt:\nrss reader with cron");
	});

	it("returns cleaned AI prompt text", async () => {
		const ai: CloudflareAIBinding = {
			run: async () => ({
				response: "Refined prompt: Build an RSS reader mini app with scheduled sync, persistent read state, and an embedded unread-feed block.",
			}),
		};

		await expect(refineAgentPrompt(ai, {
			mode: "build",
			prompt: "rss reader",
		})).resolves.toBe("Build an RSS reader mini app with scheduled sync, persistent read state, and an embedded unread-feed block.");
	});

	it("handles OpenAI-style AI responses", async () => {
		const ai: CloudflareAIBinding = {
			run: async () => ({
				choices: [{
					message: {
						content: "Create a concise Kubernetes checklist for the current document.",
					},
				}],
			}),
		};

		await expect(refineAgentPrompt(ai, {
			mode: "ask",
			prompt: "k8s checklist",
		})).resolves.toBe("Create a concise Kubernetes checklist for the current document.");
	});
});
