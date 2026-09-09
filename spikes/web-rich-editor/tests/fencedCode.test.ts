import assert from "node:assert/strict";
import test from "node:test";
import { getSchema, Node as TiptapNode } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo } from "@tiptap/pm/history";
import { canonicalNote } from "../src/lib/note";
import { defaultComponent } from "../src/lib/component";
import { fromEditorJSON, toEditorJSON } from "../src/editor/adapter";
import { portableExtensions } from "../src/editor/portableExtensions";
import {
	createFenceEnterTransaction,
	createFencedPasteTransaction,
	fencedTextNote,
	FencedCodeAuthoring,
	parseCompletedFences,
} from "../src/editor/fencedCode";

const ComponentNode = TiptapNode.create({
	name: "component",
	group: "inline",
	inline: true,
	atom: true,
	addAttributes: () => ({ component: { default: null } }),
	renderHTML: () => ["span"],
});
const schema = getSchema([
	StarterKit.configure({
		code: false,
		codeBlock: false,
		horizontalRule: false,
	}),
	...portableExtensions(),
	ComponentNode,
	FencedCodeAuthoring,
]);
function plainState(text = "", caret = text.length + 1) {
	const doc = schema.nodes.doc!.create(
		null,
		schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined),
	);
	return EditorState.create({
		schema,
		doc,
		selection: TextSelection.create(doc, caret),
		plugins: [history()],
	});
}
function applyPaste(text: string, state = plainState()) {
	const transaction = createFencedPasteTransaction(state, text);
	assert.ok(transaction);
	transaction.doc.check();
	return state.apply(transaction);
}

test("parses only completed line-start fences and retains exact UTF-16 source", () => {
	const input =
		"Before 👩🏽‍💻\r\n  ````C++ custom-info\r\n  α\tβ\r\n```\r\n\r\n  `````  \r\nAfter";
	const fences = parseCompletedFences(input);
	assert.equal(fences.length, 1);
	assert.deepEqual(fences[0], {
		from: input.indexOf("  ````"),
		to: input.indexOf("\r\nAfter"),
		language: "C++ custom-info",
		source: "  α\tβ\r\n```\r\n",
		fenceLength: 4,
	});
	for (const text of [
		"```d2\na -> b",
		"```",
		"inline ```d2\na -> b\n```",
		"    ```d2\na -> b\n    ```",
		"```we`ird\nx\n```",
	])
		assert.deepEqual(parseCompletedFences(text), []);
});

test("plain paste yields real diagrams and arbitrary code, with surrounding prose intact", () => {
	const input =
		"Before\n```d2\na -> b\n```\nBetween\n```mermaid\nflowchart LR\n  A --> B\n```\n```C++\nint x = 1;\n```\n```\nplain code\n```\nAfter";
	const state = applyPaste(input);
	const note = fromEditorJSON(state.doc.toJSON());
	assert.deepEqual(
		note.segments.map((segment) => segment.type),
		[
			"text",
			"component",
			"text",
			"component",
			"text",
			"code",
			"text",
			"code",
			"text",
		],
	);
	const components = note.segments.filter(
		(segment) => segment.type === "component",
	);
	assert.equal(components[0]!.component.kind, "diagram");
	assert.equal(components[0]!.component.source, "a -> b");
	assert.equal(components[1]!.component.kind, "mermaid");
	assert.equal(components[1]!.component.source, "flowchart LR\n  A --> B");
	assert.notEqual(components[0]!.component.id, components[1]!.component.id);
	assert.deepEqual(
		note.segments
			.filter((segment) => segment.type === "text")
			.map((segment) => segment.text),
		["Before\n", "\nBetween\n", "\n", "\n", "\nAfter"],
	);
	assert.deepEqual(
		note.segments.filter((segment) => segment.type === "code"),
		[
			{ type: "code", language: "C++", source: "int x = 1;" },
			{ type: "code", language: "", source: "plain code" },
		],
	);
	assert.ok(
		state.doc.content.content.some((node) => node.type.name === "codeBlock"),
	);
});

test("plain paste joins paragraph edges without deleting adjacent existing text", () => {
	const result = applyPaste(
		"intro\n```swift\nlet a = 1\n```\nend",
		plainState("beforeafter", 7),
	);
	assert.deepEqual(fromEditorJSON(result.doc.toJSON()).segments, [
		{ type: "text", text: "beforeintro\n" },
		{ type: "code", language: "swift", source: "let a = 1" },
		{ type: "text", text: "\nendafter" },
	]);
});

test("CRLF, empty fences and unclosed remainder survive the portable projection", () => {
	const input =
		'start\r\n```shell\r\nprintf "hi"\r\n\r\n```\r\n```\r\n```\r\n```d2\r\nnot closed';
	const expected = fencedTextNote(input)!;
	const actual = fromEditorJSON(applyPaste(input).doc.toJSON());
	assert.deepEqual(actual, canonicalNote(expected));
	assert.equal(
		actual.segments.filter((segment) => segment.type === "code")[0]!.source,
		'printf "hi"\r\n',
	);
	assert.ok(
		actual.segments.some(
			(segment) =>
				segment.type === "text" && segment.text.includes("```d2\r\nnot closed"),
		),
	);
	assert.equal(
		createFencedPasteTransaction(plainState(), "```d2\na -> b"),
		undefined,
	);
});

test("fenced paste is one undoable transaction and redo restores the same component ID", () => {
	const before = plainState("kept", 5);
	let state = applyPaste("\n```d2\na -> b\n```\n", before);
	const after = state.doc.toJSON();
	assert.ok(
		undo(state, (transaction) => {
			state = state.apply(transaction);
		}),
	);
	assert.deepEqual(state.doc.toJSON(), before.doc.toJSON());
	assert.ok(
		redo(state, (transaction) => {
			state = state.apply(transaction);
		}),
	);
	assert.deepEqual(state.doc.toJSON(), after);
});

test("pasted fences inside existing code or portable inline code remain literal", () => {
	for (const type of ["codeBlock", "portableCode"]) {
		const code = schema.nodes[type]!.create(
			{ language: "text" },
			schema.text("existing"),
		);
		const doc = schema.nodes.doc!.create(
			null,
			type === "portableCode"
				? schema.nodes.paragraph!.create(null, code)
				: code,
		);
		const state = EditorState.create({
			doc,
			selection: TextSelection.create(doc, type === "portableCode" ? 2 : 1),
		});
		assert.equal(
			createFencedPasteTransaction(state, "```d2\na -> b\n```"),
			undefined,
		);
	}
});

test("typed opening and closing Enter create a D2 component only after completion", () => {
	let state = plainState("```d2");
	const opening = createFenceEnterTransaction(state);
	assert.ok(opening);
	state = state.apply(opening);
	assert.equal(state.doc.firstChild!.type.name, "codeBlock");
	assert.equal(state.doc.firstChild!.attrs.fenceAuthoringLength, 3);
	assert.equal(state.doc.firstChild!.attrs.language, "d2");
	state = state.apply(state.tr.insertText("a -> b\n```"));
	const closing = createFenceEnterTransaction(state);
	assert.ok(closing);
	state = state.apply(closing);
	state.doc.check();
	assert.equal(state.doc.firstChild!.firstChild!.type.name, "component");
	assert.equal(
		state.doc.firstChild!.firstChild!.attrs.component.source,
		"a -> b",
	);
	assert.equal(state.selection.$from.parent.type.name, "paragraph");
	assert.equal(state.selection.$from.parentOffset, 0);
	assert.ok(
		undo(state, (transaction) => {
			state = state.apply(transaction);
		}),
	);
	assert.equal(state.doc.firstChild!.type.name, "codeBlock");
	assert.equal(state.doc.firstChild!.textContent, "a -> b\n```");
});

test("typed Mermaid and ordinary code preserve language and body, and longer fences protect shorter literals", () => {
	for (const [language, expectedKind] of [
		["mermaid", "component"],
		["bash", "codeBlock"],
		["unknown-language+1", "codeBlock"],
		["", "codeBlock"],
	]) {
		let state = plainState(`\`\`\`\`${language}`);
		state = state.apply(createFenceEnterTransaction(state)!);
		state = state.apply(state.tr.insertText("source\n```"));
		assert.equal(createFenceEnterTransaction(state), undefined);
		state = state.apply(state.tr.insertText("\n`````"));
		state = state.apply(createFenceEnterTransaction(state)!);
		const node = state.doc.firstChild!;
		assert.equal(
			expectedKind === "component"
				? node.firstChild!.type.name
				: node.type.name,
			expectedKind,
		);
		assert.equal(
			expectedKind === "component"
				? node.firstChild!.attrs.component.source
				: node.textContent,
			"source\n```",
		);
		if (expectedKind === "codeBlock")
			assert.equal(node.attrs.language, language);
	}
});

test("existing code blocks, inline code and component paragraphs cannot become diagrams accidentally", () => {
	const doc = schema.nodes.doc!.create(
		null,
		schema.nodes.codeBlock!.create(
			{ language: "d2" },
			schema.text("literal\n```"),
		),
	);
	const state = EditorState.create({
		doc,
		selection: TextSelection.create(doc, doc.content.size - 1),
	});
	assert.equal(createFenceEnterTransaction(state), undefined);
	const component = { ...defaultComponent("diagram"), source: "a -> b" };
	const withComponent = schema.nodeFromJSON(
		toEditorJSON({
			version: 2,
			segments: [
				{ type: "component", component },
				{ type: "text", text: "```d2" },
			],
		}),
	);
	const componentState = EditorState.create({
		doc: withComponent,
		selection: TextSelection.create(
			withComponent,
			withComponent.content.size - 1,
		),
	});
	assert.equal(createFenceEnterTransaction(componentState), undefined);
	const marked = schema.nodes.doc!.create(
		null,
		schema.nodes.paragraph!.create(
			null,
			schema.text("```d2", [schema.marks.code!.create()]),
		),
	);
	assert.equal(
		createFenceEnterTransaction(
			EditorState.create({
				doc: marked,
				selection: TextSelection.create(marked, 6),
			}),
		),
		undefined,
	);
});

test("closing is not recognized when selection or caret does not end the authored block", () => {
	let state = plainState("```d2");
	state = state.apply(createFenceEnterTransaction(state)!);
	state = state.apply(state.tr.insertText("source\n```"));
	state = state.apply(
		state.tr.setSelection(TextSelection.create(state.doc, 2)),
	);
	assert.equal(createFenceEnterTransaction(state), undefined);
	state = state.apply(
		state.tr.setSelection(
			TextSelection.create(state.doc, 1, state.doc.content.size - 1),
		),
	);
	assert.equal(createFenceEnterTransaction(state), undefined);
});

test("typed fences preserve the imported separator before the authored block", () => {
	const doc = schema.nodeFromJSON(
		toEditorJSON({
			version: 2,
			segments: [{ type: "text", text: "before\r\n```d2" }],
		}),
	);
	let state = EditorState.create({
		doc,
		selection: TextSelection.create(doc, doc.content.size - 1),
	});
	state = state.apply(createFenceEnterTransaction(state)!);
	state = state.apply(state.tr.insertText("a -> b\n```"));
	state = state.apply(createFenceEnterTransaction(state)!);
	assert.deepEqual(fromEditorJSON(state.doc.toJSON()).segments[0], {
		type: "text",
		text: "before\r\n",
	});
});
