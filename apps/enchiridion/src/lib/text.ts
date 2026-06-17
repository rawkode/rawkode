import type { JsonObject } from "./types";

export function emptyTiptapDocument(): JsonObject {
	return {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [{ type: "text", text: "" }],
			},
		],
	};
}

export function extractTextFromTiptap(doc: unknown): string {
	if (!doc || typeof doc !== "object") {
		return "";
	}

	const chunks: string[] = [];
	visitNode(doc, chunks);
	return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function visitNode(node: unknown, chunks: string[]): void {
	if (!node || typeof node !== "object") {
		return;
	}

	const record = node as Record<string, unknown>;

	if (typeof record.text === "string") {
		chunks.push(record.text);
	}

	if (record.type === "extensionBlock" && record.attrs && typeof record.attrs === "object") {
		const attrs = record.attrs as Record<string, unknown>;
		chunks.push([attrs.app, attrs.block].filter(Boolean).join(" "));
	}

	if (Array.isArray(record.content)) {
		for (const child of record.content) {
			visitNode(child, chunks);
		}
	}
}

export function parseJsonObject(value: string | null | undefined, fallback: JsonObject = {}): JsonObject {
	if (!value) {
		return fallback;
	}

	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

export function parseJsonArray<T>(value: string | null | undefined, fallback: T[] = []): T[] {
	if (!value) {
		return fallback;
	}

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as T[] : fallback;
	} catch {
		return fallback;
	}
}
