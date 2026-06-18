import { describe, expect, it } from "vitest";
import { mergeExtensionBlockProps, readExtensionBlockString } from "../src/lib/extension-block-props";

describe("extension block props", () => {
	it("merges draft updates without dropping existing block metadata", () => {
		expect(mergeExtensionBlockProps({
			contextPrompt: "tell me a joke",
			id: "block-1",
			status: "draft",
		}, {
			draftPrompt: "make it shorter",
		})).toEqual({
			contextPrompt: "tell me a joke",
			draftPrompt: "make it shorter",
			id: "block-1",
			status: "draft",
		});
	});

	it("reads string draft fields and ignores non-string values", () => {
		expect(readExtensionBlockString({ draftPrompt: "continue" }, "draftPrompt")).toBe("continue");
		expect(readExtensionBlockString({ draftPrompt: 123 }, "draftPrompt")).toBe("");
		expect(readExtensionBlockString({}, "missing")).toBe("");
	});
});
