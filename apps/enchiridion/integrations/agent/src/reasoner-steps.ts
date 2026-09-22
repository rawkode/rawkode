import { stepCountIs } from "ai";

// A tool-bearing fourth step can persist a change but contains no final text.
// Reserve one tool-free answer step instead of truncating immediately afterward.
export const reasonerStepPolicy = {
	stopWhen: stepCountIs(5),
	prepareStep: ({ stepNumber }: { stepNumber: number }) =>
		stepNumber >= 4 ? { toolChoice: "none" as const } : {},
};
export interface ReasonerDiagnostic {
	stage: "model_step" | "model_completed";
	steps: number;
	finishReason:
		| "stop"
		| "length"
		| "content-filter"
		| "tool-calls"
		| "error"
		| "other";
	toolCalls: number;
	textBytes: number;
}
export const reasonerDiagnostic = (
	stage: ReasonerDiagnostic["stage"],
	steps: number,
	result: { finishReason: string; toolCalls: readonly unknown[]; text: string },
): ReasonerDiagnostic => ({
	stage,
	steps,
	finishReason:
		["stop", "length", "content-filter", "tool-calls", "error"].includes(
				result.finishReason,
			)
			? result.finishReason as ReasonerDiagnostic["finishReason"]
			: "other",
	toolCalls: result.toolCalls.length,
	textBytes: new TextEncoder().encode(result.text).byteLength,
});
