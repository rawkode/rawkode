import { strict as assert } from "node:assert";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { documentExtensions } from "../src/editor/extensions.ts";
import {
	canonicalEntityReference,
	closeEntityComposer,
	createLatestEntitySearch,
	openEntityComposer,
	reduceEntityComposer,
	selectedEntityMatch,
	typedEntityMatch,
} from "../src/editor/entityComposer.ts";

const schema = getSchema(documentExtensions());
const text = (value: string, marks?: unknown[]) => ({
	type: "text",
	text: value,
	...(marks ? { marks } : {}),
});

Deno.test("latest search aborts and ignores stale responses", async () => {
	const resolvers = new Map<string, (value: string) => void>();
	const signals = new Map<string, AbortSignal>();
	const search = createLatestEntitySearch<string, string>((query, signal) => {
		signals.set(query, signal);
		return new Promise((resolve) => resolvers.set(query, resolve));
	});
	const first = search.run("first");
	const second = search.run("second");
	assert.equal(signals.get("first")?.aborted, true);
	resolvers.get("first")?.("stale");
	resolvers.get("second")?.("current");
	assert.deepEqual(await first, { accepted: false });
	assert.deepEqual(await second, { accepted: true, value: "current" });
	search.cancel();
	assert.equal(signals.get("second")?.aborted, true);
});

Deno.test("canonical references preserve selected text and distinguish hash links from mentions", () => {
	const entity = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		label: "Alice Example",
	};
	assert.deepEqual(
		canonicalEntityReference({
			trigger: "#",
			mode: "selection",
			from: 1,
			to: 6,
			query: "Alice",
			displayText: "ALICE",
		}, entity),
		{
			version: 1,
			entityId: entity.id,
			fallbackLabel: entity.label,
			displayText: "ALICE",
			presentation: "link",
		},
	);
	assert.equal(
		canonicalEntityReference({
			trigger: "@",
			mode: "typed",
			from: 1,
			to: 4,
			query: "Ali",
			displayText: "Ali",
		}, entity).presentation,
		"mention",
	);
});
const paragraph = (content: unknown[] = []) => ({
	type: "paragraph",
	...(content.length ? { content } : {}),
});
const state = (
	content: unknown[],
	from: number,
	to = from,
): EditorState => {
	const doc = schema.nodeFromJSON({ type: "doc", content });
	return EditorState.create({
		schema,
		doc,
		selection: TextSelection.create(doc, from, to),
	});
};

Deno.test("selected text opens a hash composer without changing its display text", () => {
	const editor = state([paragraph([text("  Alice Example  ")])], 1, 18);
	assert.deepEqual(selectedEntityMatch(editor), {
		trigger: "#",
		mode: "selection",
		from: 1,
		to: 18,
		query: "Alice Example",
		displayText: "  Alice Example  ",
	});
});

Deno.test("selection composer rejects cross-block, whitespace, code, links, and entities", () => {
	assert.equal(
		selectedEntityMatch(
			state([paragraph([text("First")]), paragraph([text("Second")])], 1, 9),
		),
		null,
	);
	assert.equal(
		selectedEntityMatch(state([paragraph([text("   ")])], 1, 4)),
		null,
	);
	assert.equal(
		selectedEntityMatch(
			state([paragraph([text("x".repeat(1_001))])], 1, 1_002),
		),
		null,
	);
	assert.equal(
		selectedEntityMatch(
			state([{ type: "codeBlock", content: [text("code")] }], 1, 5),
		),
		null,
	);
	assert.equal(
		selectedEntityMatch(
			state(
				[paragraph([
					text("linked", [{
						type: "link",
						attrs: { href: "https://example.com" },
					}]),
				])],
				1,
				7,
			),
		),
		null,
	);
	assert.equal(
		selectedEntityMatch(
			state(
				[paragraph([{
					type: "entity",
					attrs: {
						entity: {
							version: 1,
							entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							fallbackLabel: "Alice",
							displayText: "Alice",
							presentation: "link",
						},
					},
				}])],
				1,
				2,
			),
		),
		null,
	);
});

Deno.test("typed entity tokens honor boundaries and Markdown heading precedence", () => {
	assert.deepEqual(
		typedEntityMatch(state([paragraph([text("See #Alice Example")])], 19)),
		{
			trigger: "#",
			mode: "typed",
			from: 5,
			to: 19,
			query: "Alice Example",
			displayText: "Alice Example",
		},
	);
	assert.deepEqual(
		typedEntityMatch(state([paragraph([text("@Ada")])], 5)),
		{
			trigger: "@",
			mode: "typed",
			from: 1,
			to: 5,
			query: "Ada",
			displayText: "Ada",
		},
	);
	assert.equal(typedEntityMatch(state([paragraph([text("C#")])], 3)), null);
	assert.equal(typedEntityMatch(state([paragraph([text("# ")])], 3)), null);
	assert.equal(
		typedEntityMatch(
			state([paragraph([text("#Ada", [{ type: "code" }])])], 5),
		),
		null,
	);
});

Deno.test("composer meta opens and closes selection state deterministically", () => {
	const editor = state([paragraph([text("Alice")])], 1, 6);
	const match = selectedEntityMatch(editor)!;
	const opened = openEntityComposer(editor.tr, match);
	assert.deepEqual(reduceEntityComposer(opened, null, editor), match);
	const closed = closeEntityComposer(editor.tr);
	assert.equal(reduceEntityComposer(closed, match, editor), null);

	const moved = editor.apply(
		editor.tr.setSelection(TextSelection.create(editor.doc, 6)),
	);
	assert.equal(reduceEntityComposer(moved.tr, match, moved), null);
});
