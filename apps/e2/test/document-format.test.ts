import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import { documentExtensions } from "../website/src/editor/extensions.ts";
import {
	componentSchema,
	documentSchema,
	linkMetadataSchema,
	NOTE_LIMITS,
	NoteFormatError,
	parseComponent,
	parseEntity,
	parseNote,
	safeURL,
} from "@e2/documents/note";

const schema = getSchema(documentExtensions());
const text = (value: string) => ({ type: "text", text: value });
const paragraph = (content: unknown[] = []) => ({
	type: "paragraph",
	...(content.length ? { content } : {}),
});
const doc = (...content: unknown[]) => ({ type: "doc", content });
const component = {
	id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	kind: "diagram",
	title: "D2",
	source: "a -> b",
};
const atom = (payload = component) => ({
	type: "component",
	attrs: { component: payload },
});
const styled = (attrs: unknown) =>
	doc(
		paragraph([{ ...text("Styled"), marks: [{ type: "textStyle", attrs }] }]),
	);
const linked = (href: string, attrs: Record<string, unknown> = {}) =>
	doc(
		paragraph([
			{ ...text("Link"), marks: [{ type: "link", attrs: { href, ...attrs } }] },
		]),
	);

test("the shared fixture is exact canonical editor JSON and survives repeated reloads", () => {
	const fixture = parseNote(
		readFileSync(
			new URL(
				"../../../spikes/native-rich-editor/Tests/Fixtures/tiptap.native-note",
				import.meta.url,
			),
			"utf8",
		),
	);
	const first = schema.nodeFromJSON(fixture);
	first.check();
	const saved = parseNote(first.toJSON());
	assert.deepEqual(saved, fixture);
	const second = schema.nodeFromJSON(saved);
	second.check();
	assert.deepEqual(parseNote(second.toJSON()), fixture);
	const components: unknown[] = [];
	first.descendants((node) => {
		if (node.type.name === "component") components.push(node.attrs.component);
	});
	assert.equal(components.length, 5);
	assert.ok(first.textContent.includes("🧑🏽‍💻"));
	assert.ok(first.textContent.includes("let answer = 42\r\nprint(answer)\r\n"));
	assert.equal("version" in saved, false);
	assert.equal("segments" in saved, false);
});

test("actual editor defaults validate including nullable Link title and text style attrs", () => {
	const first = schema.nodeFromJSON(
		doc(
			paragraph([
				{
					...text("A link"),
					marks: [
						{ type: "link", attrs: { href: "https://example.com/" } },
						{ type: "textStyle", attrs: { fontSize: "17px" } },
					],
				},
			]),
			{
				type: "orderedList",
				content: [{ type: "listItem", content: [paragraph([text("Item")])] }],
			},
			{ type: "codeBlock" },
		),
	);
	first.check();
	const saved = parseNote(first.toJSON());
	assert.deepEqual(saved, parseNote(schema.nodeFromJSON(saved).toJSON()));
	const link = first.firstChild!.firstChild!.marks.find(
		(mark) => mark.type.name === "link",
	)!;
	assert.equal(link.attrs.title, null);
});

test("component and hard-break marks are standard inline marks, not lost payload", () => {
	const inline = [
		{ ...atom(), marks: [{ type: "bold" }, { type: "code" }] },
		{ type: "hardBreak", marks: [{ type: "italic" }] },
		{
			...text("Code with emphasis"),
			marks: [{ type: "bold" }, { type: "code" }],
		},
	];
	const value = doc(paragraph(inline));
	const node = schema.nodeFromJSON(parseNote(value));
	node.check();
	const saved = parseNote(node.toJSON());
	assert.deepEqual(saved.content[0].content?.[0], inline[0]);
	assert.deepEqual(saved.content[0].content?.[1], inline[1]);
});

test("nested mixed lists, task state, multiple paragraphs and quotes retain structure", () => {
	const value = doc({
		type: "orderedList",
		attrs: { start: 7, type: "1" },
		content: [
			{
				type: "listItem",
				content: [
					paragraph([text("First")]),
					paragraph([text("Continuation")]),
					{
						type: "blockquote",
						content: [
							paragraph([text("Quoted")]),
							{
								type: "heading",
								attrs: { level: 3 },
								content: [text("Within quote")],
							},
						],
					},
					{
						type: "taskList",
						content: [
							{
								type: "taskItem",
								attrs: { checked: true },
								content: [
									paragraph([text("Done")]),
									{
										type: "bulletList",
										content: [{ type: "listItem", content: [paragraph()] }],
									},
								],
							},
						],
					},
				],
			},
		],
	});
	const node = schema.nodeFromJSON(parseNote(value));
	node.check();
	assert.equal(node.firstChild!.attrs.start, 7);
	assert.deepEqual(
		parseNote(node.toJSON()),
		parseNote(schema.nodeFromJSON(node.toJSON()).toJSON()),
	);
});

test("only supported parent-child combinations and heading levels are accepted", () => {
	for (
		const invalid of [
			doc(text("Top-level inline")),
			doc(paragraph([{ type: "blockquote", content: [paragraph()] }])),
			doc({ type: "listItem", content: [paragraph()] }),
			doc({ type: "bulletList", content: [] }),
			doc({
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [{ type: "heading", attrs: { level: 1 } }],
					},
				],
			}),
			doc({
				type: "taskList",
				content: [{ type: "listItem", content: [paragraph()] }],
			}),
			doc({
				type: "taskList",
				content: [
					{
						type: "taskItem",
						attrs: { checked: "yes" },
						content: [paragraph()],
					},
				],
			}),
			doc({
				type: "orderedList",
				attrs: { start: 0 },
				content: [{ type: "listItem", content: [paragraph()] }],
			}),
			doc({
				type: "orderedList",
				attrs: { type: "a" },
				content: [{ type: "listItem", content: [paragraph()] }],
			}),
			doc({ type: "heading", attrs: { level: 4 } }),
			doc({ type: "heading" }),
			doc({ type: "codeBlock", content: [atom()] }),
			doc({
				type: "codeBlock",
				content: [{ ...text("Marked"), marks: [{ type: "bold" }] }],
			}),
			doc({ type: "blockquote", content: [] }),
			doc(),
		]
	) {
		assert.throws(() => parseNote(invalid), NoteFormatError);
	}
});

test("unknown nodes, fields and attributes reject instead of silently stripping", () => {
	for (
		const invalid of [
			{ version: 2, segments: [] },
			{ ...doc(paragraph()), version: 3 },
			doc({ type: "horizontalRule" }),
			doc({ ...paragraph(), attrs: { boundary: "\n" } }),
			doc({ ...paragraph(), attrs: { textAlign: "start" } }),
			doc(paragraph([{ ...text("Text"), unexpected: true }])),
			doc(
				paragraph([
					{
						...text("Text"),
						marks: [{ type: "bold", attrs: { weight: 900 } }],
					},
				]),
			),
			doc(paragraph([{ ...text("Text"), marks: [{ type: "superscript" }] }])),
			styled({ lineHeight: "1.5" }),
			linked("https://example.com/", { onclick: "alert(1)" }),
			doc(paragraph([atom({ ...component, extra: true } as typeof component)])),
		]
	) {
		assert.throws(() => parseNote(invalid), NoteFormatError);
	}
});

test("entity mentions keep provider identity and reject unsupported payloads", () => {
	const entity = {
		provider: "google",
		kind: "person",
		id: "connection:people/123",
		label: "Alice Example",
		meta: "alice@example.com",
	};
	const value = doc(paragraph([{ type: "entity", attrs: { entity } }]));
	assert.deepEqual(parseEntity(entity), entity);
	assert.deepEqual(parseNote(value), value);
	for (
		const invalid of [
			{ ...entity, provider: "unknown" },
			{ ...entity, id: "connection:\u0000people" },
			{ ...entity, label: "" },
		]
	) assert.throws(() => parseEntity(invalid), NoteFormatError);
});

test("all supported CSS colors and nullable visual defaults are accepted unchanged", () => {
	for (
		const color of [
			"#123",
			"#1234",
			"#123ABC",
			"#123abc80",
			"rgb(0, 128, 255)",
			"rgba(255, 0, 128, 0.25)",
			"red",
			"transparent",
		]
	) {
		const value = styled({
			fontFamily: '"Helvetica Neue", sans-serif',
			fontSize: "17.5px",
			color,
			backgroundColor: null,
		});
		assert.deepEqual(parseNote(value), value);
	}
	assert.doesNotThrow(() =>
		parseNote(
			styled({
				fontFamily: null,
				fontSize: null,
				color: null,
				backgroundColor: null,
			}),
		)
	);
	for (
		const attrs of [
			{ fontSize: "0px" },
			{ fontSize: "513px" },
			{ fontSize: "20;display:none" },
			{ fontSize: "2em" },
			{ fontFamily: "serif; color: red" },
			{ color: "url(javascript:alert(1))" },
			{ color: "rgb(256, 0, 0)" },
			{ color: "rgba(0, 0, 0, 1.1)" },
			{ backgroundColor: "var(--external)" },
		]
	) {
		assert.throws(() => parseNote(styled(attrs)), NoteFormatError);
	}
});

test("URLs reject unsafe schemes, credentials and controls while preserving signed URLs", () => {
	const url =
		"https://example.com/video.mp4?signature=A%2Bb&expires=123#section";
	assert.equal(safeURL(url), url);
	assert.equal(
		safeURL("mailto:hello@example.com", true),
		"mailto:hello@example.com",
	);
	for (
		const invalid of [
			"javascript:alert(1)",
			"data:text/html,test",
			"file:///tmp/note",
			"//example.com",
			"https:/example.com",
			"https://user:password@example.com/",
			"https://example.com/\npath",
			"https://example.com/a b",
			"not a URL",
		]
	) {
		assert.throws(() => safeURL(invalid), NoteFormatError);
		assert.throws(() => parseNote(linked(invalid)), NoteFormatError);
	}
	assert.throws(() => safeURL("mailto:hello@example.com"), NoteFormatError);
	assert.doesNotThrow(() =>
		parseNote(
			linked("mailto:hello@example.com", {
				target: null,
				rel: null,
				class: null,
				title: null,
			}),
		)
	);
	assert.throws(
		() => parseNote(linked(url, { target: "_top" })),
		NoteFormatError,
	);
});

test("component and metadata schemas share clean playback and strict nested data", () => {
	const metadata = {
		title: "Video",
		playback: { type: "directVideo", url: "https://example.com/video.mp4" },
	};
	assert.deepEqual(linkMetadataSchema.parse(metadata), metadata);
	assert.deepEqual(
		parseComponent({
			...component,
			kind: "link",
			source: "https://example.com/",
			metadata,
		}).metadata,
		metadata,
	);
	assert.equal(
		componentSchema.safeParse({
			...component,
			kind: "link",
			source: "javascript:alert(1)",
		}).success,
		false,
	);
	assert.equal(
		linkMetadataSchema.safeParse({
			title: "Old format",
			playback: { directVideo: { _0: "https://example.com/video.mp4" } },
		}).success,
		false,
	);
	assert.equal(
		linkMetadataSchema.safeParse({
			title: "Unsafe",
			playback: { type: "embedURL", url: "data:text/html,unsafe" },
		}).success,
		false,
	);
	assert.equal(
		componentSchema.safeParse({
			...component,
			drawing: { elements: [], extra: true },
		}).success,
		false,
	);
});

test("IDs are valid and unique across the document and within each drawing", () => {
	assert.throws(
		() =>
			parseNote(
				doc(
					paragraph([
						atom(),
						atom({ ...component, id: component.id.toUpperCase() }),
					]),
				),
			),
		/Duplicate component ID/,
	);
	assert.throws(
		() => parseComponent({ ...component, id: "not-a-uuid" }),
		NoteFormatError,
	);
	const element = {
		id: component.id,
		kind: "pen",
		ink: "graphite",
		points: [{ x: 0, y: 1 }],
		text: "",
		lineWidth: 2,
	};
	assert.throws(
		() =>
			parseComponent({
				...component,
				kind: "drawing",
				drawing: { elements: [element, element] },
			}),
		/Duplicate drawing element ID/,
	);
	for (
		const invalid of [
			{ ...element, lineWidth: 0 },
			{ ...element, points: [{ x: Infinity, y: 1 }] },
			{ ...element, points: [{ x: 100_001, y: 0 }] },
		]
	) {
		assert.throws(
			() => parseComponent({ ...component, drawing: { elements: [invalid] } }),
			NoteFormatError,
		);
	}
});

test("empty text and duplicate marks fail, while valid Unicode and code whitespace survive", () => {
	assert.throws(() => parseNote(doc(paragraph([text("")]))), NoteFormatError);
	assert.throws(
		() => parseNote(doc(paragraph([text("\ud800")]))),
		NoteFormatError,
	);
	assert.throws(
		() =>
			parseNote(
				doc(
					paragraph([
						{
							...text("Duplicate"),
							marks: [{ type: "bold" }, { type: "bold" }],
						},
					]),
				),
			),
		/same mark type/,
	);
	const value = doc({
		type: "codeBlock",
		attrs: { language: "text" },
		content: [text("\t日本語 🧑🏽‍💻\r\n\n\u2028\u2029\v")],
	});
	assert.deepEqual(parseNote(value), value);
});

test("global node, nesting, text and component limits fail before persistence", () => {
	assert.equal(
		documentSchema.safeParse(
			doc(...Array.from({ length: NOTE_LIMITS.nodes }, () => paragraph())),
		).success,
		false,
	);
	let nested: unknown = paragraph();
	for (let index = 0; index < NOTE_LIMITS.depth; index++) {
		nested = { type: "blockquote", content: [nested] };
	}
	assert.throws(() => parseNote(doc(nested)), /nesting/);
	const half = "x".repeat(NOTE_LIMITS.text / 2 + 1);
	assert.throws(
		() => parseNote(doc(paragraph([text(half)]), paragraph([text(half)]))),
		/4 Mi/,
	);
	const components = Array.from(
		{ length: NOTE_LIMITS.components + 1 },
		(_, index) =>
			atom({
				...component,
				id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			}),
	);
	assert.throws(
		() => parseNote(doc(paragraph(components))),
		/1,000 components/,
	);
});

test("malformed, oversized and non-JSON input is rejected safely", () => {
	assert.throws(() => parseNote("{broken"), /valid JSON/);
	assert.throws(() => parseNote(" ".repeat(NOTE_LIMITS.bytes + 1)), /16 MiB/);
	assert.throws(
		() => parseNote(doc(paragraph([text("x".repeat(NOTE_LIMITS.bytes + 1))]))),
		/16 MiB/,
	);
	const cycle: { type: string; content: unknown[] } = {
		type: "doc",
		content: [],
	};
	cycle.content.push(cycle);
	assert.throws(() => parseNote(cycle), /Circular/);
	let invoked = false;
	const accessor = {
		get type() {
			invoked = true;
			return "doc";
		},
		content: [paragraph()],
	};
	assert.throws(() => parseNote(accessor), /accessors/);
	assert.equal(invoked, false);
	assert.throws(() => parseNote(new Date()), /plain JSON/);
});
