import { strict as assert } from "node:assert";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
	reasonerDiagnostic,
	reasonerStepPolicy,
} from "../src/reasoner-steps.ts";
const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const workflow = () => {
	let modelSteps = 0, writes = 0;
	const operations: string[] = [];
	const model = new MockLanguageModelV4({
		doGenerate: (options) => {
			const step = modelSteps++;
			if (step < 4) {
				return Promise.resolve({
					content: [{
						type: "tool-call" as const,
						toolCallId: `call-${step}`,
						toolName: "codemode",
						input: JSON.stringify({
							operation: ["search", "schema", "create", "readback"][step],
						}),
					}],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				});
			}
			assert.deepEqual(options.toolChoice, { type: "none" });
			assert.ok(JSON.stringify(options.prompt).includes("persisted-url"));
			return Promise.resolve({
				content: [{
					type: "text" as const,
					text: "Saved the link and verified its URL.",
				}],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			});
		},
	});
	const tools = {
		codemode: tool({
			inputSchema: z.object({ operation: z.string() }),
			execute: ({ operation }) => {
				operations.push(operation);
				if (operation === "create") writes++;
				return Promise.resolve(
					operation === "readback" ? { url: "persisted-url" } : { ok: true },
				);
			},
		}),
	};
	return { model, tools, operations, writes: () => writes };
};
Deno.test("four tool-bearing SDK steps need a fifth tool-free final answer without replaying persistence", async () => {
	const previous = workflow();
	const oldResult = await generateText({
		model: previous.model,
		tools: previous.tools,
		prompt: "Save and verify link",
		stopWhen: stepCountIs(4),
	});
	assert.equal(oldResult.text, "");
	assert.equal(previous.writes(), 1);
	const current = workflow();
	const diagnostics: unknown[] = [];
	const result = await generateText({
		model: current.model,
		tools: current.tools,
		prompt: "Save and verify link",
		...reasonerStepPolicy,
		onStepFinish: (step) => {
			diagnostics.push(
				reasonerDiagnostic("model_step", diagnostics.length + 1, step),
			);
		},
	});
	assert.equal(result.text, "Saved the link and verified its URL.");
	assert.equal(result.steps.length, 5);
	assert.equal(current.writes(), 1);
	assert.deepEqual(current.operations, [
		"search",
		"schema",
		"create",
		"readback",
	]);
	assert.ok(!JSON.stringify(diagnostics).includes("persisted-url"));
	assert.ok(!JSON.stringify(diagnostics).includes("call-"));
});
Deno.test("reasoner diagnostics retain only bounded stage metadata", () => {
	const result = reasonerDiagnostic("model_completed", 5, {
		finishReason: "private failure",
		text: "secret",
		toolCalls: [{ arguments: "private" }],
	});
	assert.deepEqual(result, {
		stage: "model_completed",
		steps: 5,
		finishReason: "other",
		toolCalls: 1,
		textBytes: 6,
	});
});
