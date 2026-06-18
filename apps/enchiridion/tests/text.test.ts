import { describe, expect, it } from "vitest";
import { emptyTiptapDocument, extractTextFromTiptap, parseJsonArray, parseJsonObject, textToTiptapBlocks } from "../src/lib/text";

describe("tiptap text extraction", () => {
	it("returns an empty string for the initial document", () => {
		expect(extractTextFromTiptap(emptyTiptapDocument())).toBe("");
	});

	it("indexes normal text and extension block references", () => {
		expect(extractTextFromTiptap({
			type: "doc",
			content: [
				{ type: "heading", content: [{ type: "text", text: "Daily capture" }] },
				{
					type: "extensionBlock",
					attrs: {
						app: "bookmarks",
						block: "bookmark-query",
						props: { tag: "cloudflare" },
					},
				},
				{
					type: "admonition",
					attrs: {
						kind: "warning",
						title: "Warning",
					},
					content: [{ type: "paragraph", content: [{ type: "text", text: "Check the dispatch namespace." }] }],
				},
				{
					type: "paragraph",
					content: [{
						type: "referenceMention",
						attrs: {
							targetId: "project:1",
							label: "Enchiridion platform",
							sourceApp: "projects",
							sourceType: "project",
							sourceId: "1",
							href: "/apps/projects",
							referenceKind: "resource",
						},
					}],
				},
				{
					type: "youtubeEmbed",
					attrs: {
						videoId: "dQw4w9WgXcQ",
						title: "YouTube video",
						url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
					},
				},
				{ type: "paragraph", content: [{ type: "text", text: "Review links after lunch." }] },
			],
		})).toBe("Daily capture bookmarks bookmark-query warning Warning Check the dispatch namespace. Enchiridion platform YouTube video https://www.youtube.com/watch?v=dQw4w9WgXcQ Review links after lunch.");
	});
});

describe("json parsing helpers", () => {
	it("uses fallbacks for invalid shapes", () => {
		expect(parseJsonObject("[1,2,3]", { fallback: true })).toEqual({ fallback: true });
		expect(parseJsonArray<{ id: string }>("{\"id\":\"wrong\"}", [{ id: "fallback" }])).toEqual([{ id: "fallback" }]);
	});
});

describe("text to tiptap blocks", () => {
	it("keeps plain multiline prose as separate paragraphs across blank lines", () => {
		expect(textToTiptapBlocks("One line\ncontinues here\n\nSecond paragraph")).toEqual([
			{ type: "paragraph", content: [{ type: "text", text: "One line continues here" }] },
			{ type: "paragraph", content: [{ type: "text", text: "Second paragraph" }] },
		]);
	});

	it("preserves common markdown-like structure for promoted agent responses", () => {
		expect(textToTiptapBlocks([
			"# Plan",
			"- Capture inbox",
			"- Review PRs",
			"",
			"1. Prepare brief",
			"2. Send update",
			"",
			"> Decision recorded",
			"> [!WARNING] Check dispatch namespace bindings",
			"",
			"```",
			"kubectl get pods",
			"```",
		].join("\n"))).toEqual([
			{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
			{
				type: "bulletList",
				content: [
					{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Capture inbox" }] }] },
					{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Review PRs" }] }] },
				],
			},
			{
				type: "orderedList",
				content: [
					{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Prepare brief" }] }] },
					{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Send update" }] }] },
				],
			},
			{
				type: "blockquote",
				content: [{ type: "paragraph", content: [{ type: "text", text: "Decision recorded" }] }],
			},
			{
				type: "admonition",
				attrs: { kind: "warning", title: "Warning" },
				content: [{ type: "paragraph", content: [{ type: "text", text: "Check dispatch namespace bindings" }] }],
			},
			{
				type: "codeBlock",
				content: [{ type: "text", text: "kubectl get pods" }],
			},
		]);
	});
});
