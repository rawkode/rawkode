import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { Editor, getSchema, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import {
	canonicalNote,
	parseNote,
	safeURL,
	type Component,
	type PortableNote,
	type Segment,
	type TextStyle,
} from "../src/lib/note";
import { fromEditorJSON, toEditorJSON } from "../src/editor/adapter";
import { portableExtensions } from "../src/editor/portableExtensions";

const component: Component = {
	id: "abcde123-0000-4000-8000-000000000001",
	kind: "diagram",
	title: "Flow",
	source: "a -> b",
	svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Safe as untrusted data</text></svg>',
};
const ComponentNode = TiptapNode.create({
	name: "component",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes: () => ({ component: { default: null } }),
	renderHTML: () => ["span"],
});
const extensions = () => [
	StarterKit.configure({
		heading: { levels: [1, 2, 3] },
		horizontalRule: false,
		code: false,
		codeBlock: false,
		trailingNode: false,
	}),
	TaskList,
	TaskItem.configure({ nested: true }),
	...portableExtensions(),
	ComponentNode,
];
const schema = getSchema(extensions());
const text = (text: string, style: TextStyle = {}): Segment => ({
	type: "text",
	text,
	...style,
});
const note = (...segments: Segment[]): PortableNote => ({
	version: 2,
	segments,
});
function roundtrip(input: PortableNote) {
	const json = toEditorJSON(input);
	const document = schema.nodeFromJSON(json);
	document.check();
	const first = fromEditorJSON(document.toJSON());
	const second = fromEditorJSON(
		schema.nodeFromJSON(toEditorJSON(first)).toJSON(),
	);
	assert.deepEqual(first, canonicalNote(input));
	assert.deepEqual(second, first);
	return { json: document.toJSON(), note: first };
}

test("empty note, blank lines, tabs, UTF-16 and exact paragraph separators survive twice", () => {
	for (const value of [
		"",
		"hello",
		"a\nb\n",
		"\n\n",
		"👩🏽‍💻 café\t地球\r\n\r\nend\r",
		"a\u2028b\u2029c",
	]) {
		roundtrip(value ? note(text(value)) : note());
	}
});

test("mixed marks, font data and separator marks are retained", () => {
	roundtrip(
		note(
			text("A ", {
				marks: { bold: true },
				fontFamily: ".AppleSystemUIFont",
				fontSize: 17,
				foreground: "text",
			}),
			text("link", {
				marks: {
					italic: true,
					underline: true,
					strike: true,
					inlineCode: true,
					link: "https://example.com/?a=1&b=2",
				},
				background: "#ffffff80",
			}),
			text("\r\n", { marks: { bold: true } }),
			text("next", { foreground: "#010203ff" }),
		),
	);
});

test("headings, quotes and their empty paragraphs retain semantics", () => {
	roundtrip(
		note(
			text("Heading\n", {
				paragraph: { kind: "heading1", alignment: "center" },
			}),
			text("\n", { paragraph: { kind: "quote" } }),
			text("Words", { paragraph: { kind: "paragraph" } }),
		),
	);
});

test("code blocks keep CRLF source and zero added component boundaries", () => {
	roundtrip(
		note(
			{ type: "code", language: "swift", source: "let a = 1\r\nprint(a)\r\n" },
			text("\n"),
			{ type: "component", component },
			{
				type: "component",
				component: {
					...component,
					id: "abcde123-0000-4000-8000-000000000002",
					kind: "mermaid",
					source: "flowchart LR\n A --> B",
				},
			},
			text("after"),
			{ type: "code", language: "", source: "" },
			text("\n"),
			{ type: "code", language: "text", source: "" },
		),
	);
});

test("a code range in prose stays editable and inline without newlines", () => {
	const result = roundtrip(
		note(
			text("before"),
			{ type: "code", language: "sh", source: "echo hi\necho bye" },
			text("after"),
		),
	);
	assert.equal(result.json.content[0].content[1].type, "portableCode");
});

test("nested mixed lists preserve their paths, checked states, numbering and marks", () => {
	roundtrip(
		note(
			text("one", {
				marks: { bold: true },
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered"], start: 3 },
				},
			}),
			text("\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered"], start: 3 },
				},
			}),
			text("nested\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered", "bullet"] },
				},
			}),
			text("task\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered", "bullet", "task"], checked: true },
				},
			}),
			text("four\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered"], start: 4 },
				},
			}),
			text("restart\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["numbered"], start: 1 },
				},
			}),
			text("normal"),
		),
	);
});

test("indented first items need no manufactured parent text", () => {
	roundtrip(
		note(
			text("deep\n", {
				paragraph: {
					kind: "heading2",
					list: { path: ["bullet", "numbered", "task"], checked: false },
				},
			}),
			text("next", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["bullet", "numbered"], start: 1 },
				},
			}),
		),
	);
});

test("new paragraph boundaries after pressing Enter serialize as LF", () => {
	const json = toEditorJSON(note(text("hello")));
	json.content!.push({
		type: "paragraph",
		content: [{ type: "text", text: "world" }],
	});
	assert.deepEqual(fromEditorJSON(json), note(text("hello\nworld")));
	const withTrailing = toEditorJSON(note(text("hello\n")));
	withTrailing.content!.pop();
	assert.deepEqual(fromEditorJSON(withTrailing), note(text("hello")));
});

test("real paragraph joins preserve the untouched following separator and its marks", () => {
	const editor = new Editor({
		element: null,
		extensions: extensions(),
		content: toEditorJSON(
			note(
				text("one\r\n"),
				text("two"),
				text("\n", { marks: { bold: true } }),
				text("three"),
			),
		),
	});
	editor.commands.setTextSelection(6);
	assert.equal(editor.commands.joinBackward(), true);
	const result = fromEditorJSON(editor.getJSON());
	assert.deepEqual(
		result,
		note(text("onetwo"), text("\n", { marks: { bold: true } }), text("three")),
	);
	roundtrip(result);
	editor.destroy();
});

test("real Enter splits create one LF and preserve both untouched mixed boundaries", () => {
	for (const position of [3, 7, 9]) {
		const editor = new Editor({
			element: null,
			extensions: extensions(),
			content: toEditorJSON(note(text("one\r\ntwo\nthree"))),
		});
		editor.commands.setTextSelection(position);
		assert.equal(editor.commands.splitBlock(), true);
		const result = fromEditorJSON(editor.getJSON());
		const expected =
			position === 3
				? "on\ne\r\ntwo\nthree"
				: position === 7
					? "one\r\nt\nwo\nthree"
					: "one\r\ntwo\n\nthree";
		assert.deepEqual(result, note(text(expected)));
		roundtrip(result);
		editor.destroy();
	}
});

test("a split followed by a join does not resurrect an older CRLF boundary", () => {
	const editor = new Editor({
		element: null,
		extensions: extensions(),
		content: toEditorJSON(note(text("one\r\ntwo\nthree"))),
	});
	editor.view.updateState(
		editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
	);
	editor.commands.setTextSelection(7);
	assert.equal(editor.commands.splitBlock(), true);
	editor.commands.setTextSelection(6);
	assert.equal(editor.commands.joinBackward(), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(text("onet\nwo\nthree")),
	);
	editor.destroy();
});

test("Enter at the start of a heading leaves its existing incoming CRLF before the new empty paragraph", () => {
	const editor = new Editor({
		element: null,
		extensions: extensions(),
		content: toEditorJSON(
			note(
				text("before\r\n"),
				text("heading\n", { paragraph: { kind: "heading1" } }),
				text("after"),
			),
		),
	});
	editor.view.updateState(
		editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
	);
	editor.commands.setTextSelection(9);
	assert.equal(editor.commands.splitBlock(), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(
			text("before\r\n\n"),
			text("heading\n", { paragraph: { kind: "heading1" } }),
			text("after"),
		),
	);
	editor.destroy();
});

test("code conversion commands refuse to remove components or mixed inline code", () => {
	for (const protectedSegment of [
		{ type: "component", component },
		{ type: "code", language: "swift", source: "let a = 1" },
	] as Segment[]) {
		const input = note(text("before"), protectedSegment, text("after"));
		const editor = new Editor({
			element: null,
			extensions: extensions(),
			content: toEditorJSON(input),
		});
		editor.commands.setTextSelection(2);
		assert.equal(editor.commands.setCodeBlock(), false);
		assert.equal(editor.commands.toggleCodeBlock(), false);
		assert.deepEqual(fromEditorJSON(editor.getJSON()), input);
		editor.destroy();
	}
	const editor = new Editor({
		element: null,
		extensions: extensions(),
		content: toEditorJSON(note(text("safe"))),
	});
	assert.equal(editor.commands.setCodeBlock({ language: "swift" }), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note({ type: "code", language: "swift", source: "safe" }),
	);
	editor.destroy();
});

test("fence input rules preserve incoming CRLF and refuse to remove components", () => {
	for (const protectedContent of [false, true]) {
		const input = note(
			text("before\r\n```swift"),
			...(protectedContent
				? [{ type: "component", component } as Segment]
				: []),
		);
		const editor = new Editor({
			element: null,
			extensions: extensions(),
			content: toEditorJSON(input),
		});
		editor.view.updateState(
			editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
		);
		editor.commands.setTextSelection(17);
		const { from, to } = editor.state.selection;
		const handled = editor.state.plugins.some((plugin) =>
			plugin.props.handleTextInput?.call(
				plugin,
				editor.view,
				from,
				to,
				" ",
				() => editor.state.tr.insertText(" ", from, to),
			),
		);
		assert.equal(handled, !protectedContent);
		assert.deepEqual(
			fromEditorJSON(editor.getJSON()),
			protectedContent
				? input
				: note(text("before\r\n"), {
						type: "code",
						language: "swift",
						source: "",
					}),
		);
		editor.destroy();
	}
});

test("new list and task item state is derived from current editor nodes", () => {
	assert.deepEqual(
		fromEditorJSON({
			type: "doc",
			content: [
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "done" }],
								},
							],
						},
					],
				},
			],
		}),
		note(
			text("done", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["task"], checked: true },
				},
			}),
		),
	);
});

test("omitted list defaults preserve display and do not swallow later checkbox edits", () => {
	const input = note(
		text("one\n", {
			paragraph: { kind: "paragraph", list: { path: ["numbered"] } },
		}),
		text("restart\n", {
			paragraph: { kind: "paragraph", list: { path: ["numbered"] } },
		}),
		text("task", {
			paragraph: { kind: "paragraph", list: { path: ["task"] } },
		}),
	);
	const result = roundtrip(input);
	assert.equal(result.json.content[0].attrs.start, 1);
	assert.equal(result.json.content[1].attrs.start, 1);
	result.json.content[2].content[0].attrs.checked = true;
	assert.equal(
		(
			fromEditorJSON(result.json).segments.at(-1) as Extract<
				Segment,
				{ type: "text" }
			>
		).paragraph?.list?.checked,
		true,
	);
});

test("unsafe URLs, unknown schema data and duplicate IDs reject without discarding a draft", () => {
	for (const value of [
		"javascript:alert(1)",
		"data:text/html,hi",
		"https://user:password@example.com",
		"/relative",
		"https://example.com/\nhi",
	])
		assert.throws(() => safeURL(value));
	assert.equal(
		safeURL("mailto:hello@example.com", true),
		"mailto:hello@example.com",
	);
	assert.throws(
		() => parseNote({ version: 3, segments: [] }),
		/unsupported note version/,
	);
	assert.throws(
		() => parseNote({ version: 2, segments: [], extra: "lost" }),
		/unsupported field/,
	);
	assert.throws(
		() =>
			parseNote(
				note(
					{ type: "component", component },
					{ type: "component", component },
				),
			),
		/duplicate component ID/,
	);
	assert.throws(
		() =>
			parseNote(note(text("bad", { foreground: "url(https://example.com)" }))),
		/foreground/,
	);
	assert.throws(
		() => parseNote(note(text("bad", { fontSize: Infinity }))),
		/fontSize/,
	);
	assert.throws(() => parseNote(note(text("\ud800"))), /Unicode/);
	assert.throws(
		() =>
			parseNote(
				note(
					text("bad", {
						paragraph: {
							kind: "paragraph",
							list: { path: ["bullet"], checked: true },
						},
					}),
				),
			),
		/requires a task/,
	);
	assert.throws(
		() =>
			toEditorJSON(
				note(
					text("different"),
					text("paragraph", { paragraph: { kind: "heading1" } }),
				),
			),
		/Conflicting paragraph metadata/,
	);
	assert.throws(
		() =>
			fromEditorJSON({ type: "doc", content: [{ type: "horizontalRule" }] }),
		/Unsupported editor block/,
	);
});

test("drawing and metadata payloads survive unchanged as inert data", () => {
	roundtrip(
		note(
			{
				type: "component",
				component: {
					...component,
					kind: "drawing",
					source: "",
					drawing: {
						elements: [
							{
								id: "00000000-0000-4000-8000-000000000009",
								kind: "pen",
								ink: "blue",
								points: [
									{ x: 0.25, y: 90 },
									{ x: 899, y: 419 },
								],
								text: "",
								lineWidth: 3,
							},
						],
					},
				},
			},
			{
				type: "component",
				component: {
					id: "00000000-0000-4000-8000-000000000010",
					kind: "link",
					title: "Video",
					source: "https://example.com/watch",
					metadata: {
						title: "Video",
						summary: "hello",
						imageURL: "https://example.com/poster.png",
						playback: {
							directVideo: {
								_0: "https://example.com/stream.m3u8?token=abc%2Fdef",
							},
						},
					},
				},
			},
		),
	);
});

test("multi-paragraph list item refuses lossy export with actionable error", () => {
	assert.throws(
		() =>
			fromEditorJSON({
				type: "doc",
				content: [
					{
						type: "bulletList",
						content: [
							{
								type: "listItem",
								content: [
									{
										type: "paragraph",
										content: [{ type: "text", text: "one" }],
									},
									{
										type: "paragraph",
										content: [{ type: "text", text: "two" }],
									},
								],
							},
						],
					},
				],
			}),
		/Shift-Enter/,
	);
});

test("shared native-authored portable fixture round-trips through the real editor schema", () => {
	const fixture = new URL(
		"../../native-rich-editor/Tests/Fixtures/portable-v2.native-note",
		import.meta.url,
	);
	if (!existsSync(fixture))
		throw new Error(
			"The shared native fixture is required for the interchange acceptance gate",
		);
	roundtrip(parseNote(readFileSync(fixture, "utf8")));
});
