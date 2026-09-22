import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Editor } from "@tiptap/core";
import { documentExtensions } from "../src/editor/extensions";
import { parseNote } from "../src/lib/note";

// Use the actual editor schema to normalize default attributes and mark order.
function editorJSON(value: unknown) {
	const editor = new Editor({
		element: null,
		extensions: documentExtensions(),
		content: parseNote(value),
	});
	try {
		return JSON.parse(
			JSON.stringify(editor.getJSON(), (key, item) =>
				key === "id" && typeof item === "string" ? item.toLowerCase() : item,
			),
		);
	} finally {
		editor.destroy();
	}
}

const nativeDirectory = fileURLToPath(
	new URL("../../native-rich-editor/", import.meta.url),
);
const fixture = readFileSync(
	new URL(
		"../../native-rich-editor/Tests/Fixtures/tiptap.native-note",
		import.meta.url,
	),
	"utf8",
);
const expected = editorJSON(parseNote(fixture));
const directory = mkdtempSync("/private/tmp/fieldnotes-tiptap-interop-");
const input = `${directory}/web.native-note`;
const output = `${directory}/native.native-note`;
writeFileSync(input, JSON.stringify(expected, null, 2), { flag: "wx" });
const result = spawnSync(
	"swift",
	[
		"test",
		"--filter",
		"TiptapDocumentTests.testSharedFixtureRoundTripsAndCanExportForZodVerification",
	],
	{
		cwd: nativeDirectory,
		env: {
			...process.env,
			FIELDNOTES_ROUNDTRIP_INPUT: input,
			FIELDNOTES_ROUNDTRIP_OUTPUT: output,
		},
		stdio: "inherit",
	},
);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Native document round trip failed");
const returned = editorJSON(parseNote(readFileSync(output, "utf8")));
assert.deepEqual(
	returned,
	expected,
	"Swift changed the canonical document (after standard Tiptap defaults and UUID case normalization)",
);
console.log(
	`Web → Swift → Zod → Tiptap round trip passed. Artifacts: ${directory}`,
);
