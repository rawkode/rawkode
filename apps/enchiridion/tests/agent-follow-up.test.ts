import { describe, expect, it } from "vitest";
import { buildFollowUpPrompt } from "../src/lib/agent-follow-up";

describe("buildFollowUpPrompt", () => {
	it("leaves standalone prompts unchanged", () => {
		expect(buildFollowUpPrompt({ prompt: "Tell me a joke" })).toBe("Tell me a joke");
	});

	it("wraps follow-ups with previous request and response context", () => {
		expect(buildFollowUpPrompt({
			contextPrompt: "tell me a joke",
			contextResponse: "Scientists trust atoms less because atoms make up everything.",
			prompt: "Make it shorter",
		})).toBe([
			"Continue this prior Enchiridion agent exchange.",
			"Previous request:\ntell me a joke",
			"Previous response:\nScientists trust atoms less because atoms make up everything.",
			"Follow-up request:\nMake it shorter",
		].join("\n\n"));
	});

	it("trims empty context values", () => {
		expect(buildFollowUpPrompt({
			contextPrompt: "  ",
			contextResponse: " Previous answer. ",
			prompt: "Continue",
		})).toBe([
			"Continue this prior Enchiridion agent exchange.",
			"Previous response:\nPrevious answer.",
			"Follow-up request:\nContinue",
		].join("\n\n"));
	});
});
