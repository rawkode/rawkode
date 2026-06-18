import type { CloudflareAIBinding } from "./types";

const promptRefinementModel = "@cf/zai-org/glm-5.2";

export type PromptRefinementMode = "ask" | "build" | "update";

export interface RefineAgentPromptInput {
	mode: PromptRefinementMode;
	prompt: string;
	contextPrompt?: string;
	contextResponse?: string;
	targetSlug?: string;
}

export async function refineAgentPrompt(ai: CloudflareAIBinding, input: RefineAgentPromptInput): Promise<string> {
	const result = await ai.run(promptRefinementModel, {
		messages: buildPromptRefinementMessages(input),
		max_tokens: 900,
		temperature: 0.2,
	});
	const text = cleanRefinedPrompt(await readAiText(result));
	if (!text) {
		throw new Error("AI prompt refinement returned no text.");
	}

	return text.length > 8_000 ? text.slice(0, 8_000).trim() : text;
}

export function buildPromptRefinementMessages(input: RefineAgentPromptInput): Array<{ role: "system" | "user"; content: string }> {
	return [{
		role: "system",
		content: [
			"You rewrite rough Enchiridion agent prompts into clear, actionable prompts for the current use-case.",
			"Return only the rewritten prompt text. Do not answer the prompt. Do not use markdown fences, labels, or commentary.",
			"Preserve the user's intent and wording where it matters. Do not invent credentials, URLs, data, tools, or requirements.",
			"For mini app builds or updates, make implied routes, commands, editor blocks, data stores, scheduled workflows, Cloudflare bindings, and acceptance criteria explicit.",
			"For normal agent asks, make the request specific enough to produce document-ready output.",
		].join(" "),
	}, {
		role: "user",
		content: [
			`Use-case: ${describePromptUseCase(input.mode)}`,
			input.targetSlug ? `Target mini app: ${input.targetSlug}` : "",
			input.contextPrompt?.trim() ? `Previous prompt:\n${input.contextPrompt.trim()}` : "",
			input.contextResponse?.trim() ? `Previous response excerpt:\n${input.contextResponse.trim().slice(0, 2_000)}` : "",
			`Original prompt:\n${input.prompt.trim()}`,
		].filter(Boolean).join("\n\n"),
	}];
}

function describePromptUseCase(mode: PromptRefinementMode): string {
	if (mode === "build") {
		return "build a new Enchiridion mini app through the durable Flue builder";
	}
	if (mode === "update") {
		return "update an existing Enchiridion mini app while preserving its existing contracts";
	}
	return "ask the in-document Enchiridion agent for document-ready output or an action";
}

async function readAiText(result: Response | Record<string, unknown>): Promise<string> {
	if (result instanceof Response) {
		const raw = await result.text();
		if (!result.ok) {
			throw new Error(raw.trim() || `AI prompt refinement failed with ${result.status}.`);
		}

		const contentType = result.headers.get("content-type") ?? "";
		if (contentType.includes("json")) {
			try {
				return readTextFromUnknown(JSON.parse(raw)) ?? "";
			} catch {
				return raw;
			}
		}

		return raw;
	}

	return readTextFromUnknown(result) ?? "";
}

function readTextFromUnknown(value: unknown, depth = 0): string | undefined {
	if (depth > 5 || value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		const parts = value
			.map((entry) => readTextFromUnknown(entry, depth + 1))
			.filter((entry): entry is string => Boolean(entry));
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (typeof value !== "object") {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	for (const key of ["response", "text", "content", "message", "output", "result", "data"]) {
		const text = readTextFromUnknown(record[key], depth + 1);
		if (text) {
			return text;
		}
	}

	const choices = record.choices;
	if (Array.isArray(choices)) {
		return readTextFromUnknown(choices, depth + 1);
	}

	return undefined;
}

function cleanRefinedPrompt(value: string): string {
	let text = value.trim();
	if (!text) {
		return "";
	}

	text = text
		.replace(/^```(?:\w+)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	return text.replace(/^(?:rewritten|refined|improved)\s+prompt:\s*/i, "").trim();
}
