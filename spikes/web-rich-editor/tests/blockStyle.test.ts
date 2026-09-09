import assert from "node:assert/strict";
import test from "node:test";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { applyBlockStyle } from "../src/editor/blockStyle";
import { portableExtensions } from "../src/editor/portableExtensions";
import { fromEditorJSON, toEditorJSON } from "../src/editor/adapter";
import type {
	Component,
	PortableNote,
	Segment,
	TextStyle,
} from "../src/lib/note";

const ComponentNode = Node.create({
	name: "component",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes: () => ({ component: { default: null } }),
	renderHTML: () => ["span"],
});
const component: Component = {
	id: "00000000-0000-4000-8000-000000000001",
	kind: "diagram",
	title: "A diagram",
	source: "a -> b",
};
const text = (value: string, style: TextStyle = {}): Segment => ({
	type: "text",
	text: value,
	...style,
});
const note = (...segments: Segment[]): PortableNote => ({
	version: 2,
	segments,
});
function editorFor(input: PortableNote) {
	const editor = new Editor({
		element: null,
		content: toEditorJSON(input),
		extensions: [
			StarterKit.configure({
				code: false,
				codeBlock: false,
				horizontalRule: false,
				trailingNode: false,
				heading: { levels: [1, 2, 3] },
			}),
			TaskList,
			TaskItem.configure({ nested: true }),
			...portableExtensions(),
			ComponentNode,
		],
	});
	editor.view.updateState(
		editor.state.reconfigure({ plugins: editor.extensionManager.plugins }),
	);
	return editor;
}
function selectText(editor: Editor, value: string) {
	editor.state.doc.descendants((node, position) => {
		if (node.isText && node.text === value)
			editor.commands.setTextSelection(position + 1);
	});
}

test("native heading size becomes body size while explicit bold and neighboring paragraphs stay intact", () => {
	const editor = editorFor(
		note(
			text("before\r\n", { fontSize: 17 }),
			text("Title\n", {
				fontSize: 32,
				fontFamily: "Helvetica Neue",
				marks: { bold: true, italic: true },
				foreground: "#123456ff",
				paragraph: { kind: "heading1" },
			}),
			text("after", { fontSize: 18, marks: { bold: true } }),
		),
	);
	selectText(editor, "Title");
	assert.equal(applyBlockStyle(editor, "paragraph"), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(
			text("before\r\n", { fontSize: 17 }),
			text("Title\n", {
				marks: { bold: true, italic: true },
				foreground: "#123456ff",
				paragraph: { kind: "paragraph" },
			}),
			text("after", { fontSize: 18, marks: { bold: true } }),
		),
	);
	assert.equal(editor.commands.undo(), true);
	assert.equal(editor.state.doc.child(1).type.name, "heading");
	editor.destroy();
});

test("explicit heading styles retain inline emphasis, colors, links and components", () => {
	for (const style of ["heading1", "heading2", "heading3"] as const) {
		const editor = editorFor(
			note(
				text("one", {
					fontSize: 17,
					marks: {
						bold: true,
						italic: true,
						underline: true,
						strike: true,
						link: "https://example.com/",
					},
					foreground: "secondary",
					background: "#ffffffff",
				}),
				{ type: "component", component },
				text("two", { marks: { inlineCode: true } }),
			),
		);
		editor.commands.setTextSelection(2);
		assert.equal(applyBlockStyle(editor, style), true);
		assert.deepEqual(
			fromEditorJSON(editor.getJSON()),
			note(
				text("one", {
					marks: {
						bold: true,
						italic: true,
						underline: true,
						strike: true,
						link: "https://example.com/",
					},
					foreground: "secondary",
					background: "#ffffffff",
					paragraph: { kind: style },
				}),
				{ type: "component", component },
				text("two", {
					marks: { inlineCode: true },
					paragraph: { kind: style },
				}),
			),
		);
		editor.destroy();
	}
});

test("mixed heading bold remains intentional inline emphasis", () => {
	const editor = editorFor(
		note(
			text("normal ", { fontSize: 32, paragraph: { kind: "heading1" } }),
			text("emphasis", {
				fontSize: 32,
				marks: { bold: true },
				paragraph: { kind: "heading1" },
			}),
		),
	);
	editor.commands.setTextSelection(2);
	assert.equal(applyBlockStyle(editor, "paragraph"), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(
			text("normal ", { paragraph: { kind: "paragraph" } }),
			text("emphasis", {
				marks: { bold: true },
				paragraph: { kind: "paragraph" },
			}),
		),
	);
	editor.destroy();
});

test("inline native code ranges remain intact during paragraph styling", () => {
	const editor = editorFor(
		note(
			text("before"),
			{ type: "code", language: "swift", source: "let a = 1\r\nprint(a)" },
			text("after"),
		),
	);
	editor.commands.setTextSelection(2);
	assert.equal(applyBlockStyle(editor, "heading2"), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(
			text("before", { paragraph: { kind: "heading2" } }),
			{ type: "code", language: "swift", source: "let a = 1\r\nprint(a)" },
			text("after", { paragraph: { kind: "heading2" } }),
		),
	);
	editor.destroy();
});

test("nested list to quote lifts the selected item without changing its parent or following boundary", () => {
	const editor = editorFor(
		note(
			text("Parent\r\n", {
				paragraph: { kind: "paragraph", list: { path: ["bullet"] } },
			}),
			text("Nested\n", {
				paragraph: {
					kind: "paragraph",
					list: { path: ["bullet", "task"], checked: true },
				},
			}),
			text("after"),
		),
	);
	selectText(editor, "Nested");
	assert.equal(applyBlockStyle(editor, "quote"), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(
			text("Parent\r\n", {
				paragraph: { kind: "paragraph", list: { path: ["bullet"] } },
			}),
			text("Nested\n", { paragraph: { kind: "quote" } }),
			text("after"),
		),
	);
	assert.equal(applyBlockStyle(editor, "paragraph"), true);
	assert.equal(editor.isActive("blockquote"), false);
	editor.destroy();
});

test("multi-paragraph list selection becomes quote paragraphs with exact separators", () => {
	const editor = editorFor(
		note(
			text("one\r\n", {
				paragraph: { kind: "paragraph", list: { path: ["bullet"] } },
			}),
			text("two\n", {
				paragraph: { kind: "paragraph", list: { path: ["bullet"] } },
			}),
			text("after"),
		),
	);
	let end = 0;
	editor.state.doc.descendants((node, position) => {
		if (node.isText && node.text === "two") end = position + node.nodeSize;
	});
	editor.commands.setTextSelection({ from: 3, to: end });
	assert.equal(applyBlockStyle(editor, "quote"), true);
	assert.deepEqual(
		fromEditorJSON(editor.getJSON()),
		note(text("one\r\ntwo\n", { paragraph: { kind: "quote" } }), text("after")),
	);
	editor.destroy();
});

test("code style refuses incompatible content and invalid styles do not mutate the note", () => {
	const original = note(
		text("before"),
		{ type: "component", component },
		text("after"),
	);
	const editor = editorFor(original);
	editor.commands.setTextSelection(2);
	assert.equal(applyBlockStyle(editor, "code"), false);
	assert.equal(applyBlockStyle(editor, "heading4" as never), false);
	assert.deepEqual(fromEditorJSON(editor.getJSON()), original);
	editor.destroy();
	const plain = editorFor(note(text("let a = 1")));
	assert.equal(applyBlockStyle(plain, "code"), true);
	assert.deepEqual(
		fromEditorJSON(plain.getJSON()),
		note({ type: "code", language: "", source: "let a = 1" }),
	);
	plain.destroy();
});
