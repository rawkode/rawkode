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

	if (record.type === "referenceMention" && record.attrs && typeof record.attrs === "object") {
		const attrs = record.attrs as Record<string, unknown>;
		if (typeof attrs.label === "string" && attrs.label.trim()) {
			chunks.push(attrs.label.trim());
		}
	}

	if (record.type === "admonition" && record.attrs && typeof record.attrs === "object") {
		const attrs = record.attrs as Record<string, unknown>;
		chunks.push([attrs.kind, attrs.title].filter((value) => typeof value === "string" && value).join(" "));
	}

	if (Array.isArray(record.content)) {
		for (const child of record.content) {
			visitNode(child, chunks);
		}
	}
}

export function textToTiptapBlocks(text: string): JsonObject[] {
	const lines = text.trim().split(/\r?\n/);
	const blocks: JsonObject[] = [];
	let paragraphLines: string[] = [];
	let listItems: JsonObject[] = [];
	let listKind: "bulletList" | "orderedList" | null = null;
	let codeLines: string[] | null = null;

	const flushParagraph = () => {
		if (paragraphLines.length === 0) {
			return;
		}
		blocks.push(textBlock("paragraph", paragraphLines.join(" ")));
		paragraphLines = [];
	};

	const flushList = () => {
		if (!listKind || listItems.length === 0) {
			return;
		}
		blocks.push({ type: listKind, content: listItems });
		listItems = [];
		listKind = null;
	};

	const flushCode = () => {
		if (!codeLines) {
			return;
		}
		blocks.push({
			type: "codeBlock",
			content: codeLines.length > 0 ? [{ type: "text", text: codeLines.join("\n") }] : undefined,
		});
		codeLines = null;
	};

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			if (codeLines) {
				flushCode();
				continue;
			}
			flushParagraph();
			flushList();
			codeLines = [];
			continue;
		}

		if (codeLines) {
			codeLines.push(line);
			continue;
		}

		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
		if (headingMatch) {
			flushParagraph();
			flushList();
			blocks.push({
				type: "heading",
				attrs: { level: headingMatch[1].length },
				content: [{ type: "text", text: headingMatch[2] }],
			});
			continue;
		}

		const unorderedMatch = /^[-*]\s+(.+)$/.exec(trimmed);
		if (unorderedMatch) {
			flushParagraph();
			if (listKind !== "bulletList") {
				flushList();
				listKind = "bulletList";
			}
			listItems.push(listItem(unorderedMatch[1]));
			continue;
		}

		const orderedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
		if (orderedMatch) {
			flushParagraph();
			if (listKind !== "orderedList") {
				flushList();
				listKind = "orderedList";
			}
			listItems.push(listItem(orderedMatch[1]));
			continue;
		}

		const admonitionMatch = /^>\s?\[!(INFO|NOTE|WARNING|WARN|ERROR|DANGER|SUCCESS|TIP|ALERT)\]\s*(.*)$/i.exec(trimmed);
		if (admonitionMatch) {
			const kind = markdownAdmonitionKind(admonitionMatch[1]);
			flushParagraph();
			flushList();
			blocks.push({
				type: "admonition",
				attrs: {
					kind,
					title: admonitionTitle(kind),
				},
				content: [textBlock("paragraph", admonitionMatch[2])],
			});
			continue;
		}

		const quoteMatch = /^>\s?(.+)$/.exec(trimmed);
		if (quoteMatch) {
			flushParagraph();
			flushList();
			blocks.push({
				type: "blockquote",
				content: [textBlock("paragraph", quoteMatch[1])],
			});
			continue;
		}

		flushList();
		paragraphLines.push(trimmed);
	}

	flushParagraph();
	flushList();
	flushCode();

	return blocks.length > 0 ? blocks : [{ type: "paragraph" }];
}

function textBlock(type: "paragraph", text: string): JsonObject {
	return {
		type,
		content: text ? [{ type: "text", text }] : undefined,
	};
}

function listItem(text: string): JsonObject {
	return {
		type: "listItem",
		content: [textBlock("paragraph", text)],
	};
}

function markdownAdmonitionKind(value: string): "alert" | "error" | "info" | "success" | "warning" {
	const normalized = value.trim().toLowerCase();
	if (normalized === "warning" || normalized === "warn") {
		return "warning";
	}
	if (normalized === "error" || normalized === "danger") {
		return "error";
	}
	if (normalized === "success" || normalized === "tip") {
		return "success";
	}
	if (normalized === "alert") {
		return "alert";
	}
	return "info";
}

function admonitionTitle(kind: "alert" | "error" | "info" | "success" | "warning"): string {
	return kind.charAt(0).toUpperCase() + kind.slice(1);
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
