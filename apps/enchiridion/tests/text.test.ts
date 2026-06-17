import { describe, expect, it } from "vitest";
import { emptyTiptapDocument, extractTextFromTiptap, parseJsonArray, parseJsonObject } from "../src/lib/text";

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
				{ type: "paragraph", content: [{ type: "text", text: "Review links after lunch." }] },
			],
		})).toBe("Daily capture bookmarks bookmark-query Review links after lunch.");
	});
});

describe("json parsing helpers", () => {
	it("uses fallbacks for invalid shapes", () => {
		expect(parseJsonObject("[1,2,3]", { fallback: true })).toEqual({ fallback: true });
		expect(parseJsonArray<{ id: string }>("{\"id\":\"wrong\"}", [{ id: "fallback" }])).toEqual([{ id: "fallback" }]);
	});
});
