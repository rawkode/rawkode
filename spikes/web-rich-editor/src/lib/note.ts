/** The file format is independent of both ProseMirror and AppKit. */
export type ListKind = "bullet" | "numbered" | "task";
export type ParagraphKind =
	"paragraph" | "heading1" | "heading2" | "heading3" | "quote";
export interface ParagraphStyle {
	kind: ParagraphKind;
	list?: { path: ListKind[]; checked?: boolean; start?: number };
	alignment?: "left" | "center" | "right" | "justified" | "natural";
}
export interface TextStyle {
	marks?: {
		bold?: boolean;
		italic?: boolean;
		underline?: boolean;
		strike?: boolean;
		inlineCode?: boolean;
		link?: string;
	};
	fontSize?: number;
	fontFamily?: string;
	foreground?: string;
	background?: string;
	paragraph?: ParagraphStyle;
}
export interface DrawingPoint {
	x: number;
	y: number;
}
export type DrawingInk =
	"graphite" | "blue" | "purple" | "orange" | "green" | "red";
export interface DrawingElement {
	id: string;
	kind: "pen" | "rectangle" | "ellipse" | "arrow" | "text";
	ink: DrawingInk;
	points: DrawingPoint[];
	text: string;
	lineWidth: number;
}
export interface DrawingDocument {
	elements: DrawingElement[];
}
export type Playback =
	{ directVideo: { _0: string } } | { embedURL: { _0: string } };
export interface LinkMetadata {
	title: string;
	summary?: string;
	imageURL?: string;
	playback?: Playback;
	discoveryNote?: string;
}
export interface Component {
	id: string;
	kind: "diagram" | "mermaid" | "drawing" | "link";
	title: string;
	source: string;
	svg?: string;
	drawing?: DrawingDocument;
	metadata?: LinkMetadata;
}
export type Segment =
	| ({ type: "text"; text: string } & TextStyle)
	| { type: "code"; language: string; source: string }
	| { type: "component"; component: Component };
export interface PortableNote {
	version: 2;
	segments: Segment[];
}

export const NOTE_LIMITS = {
	bytes: 16 * 1024 * 1024,
	segments: 20_000,
	text: 4 * 1024 * 1024,
	components: 1_000,
} as const;

export class NoteFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoteFormatError";
	}
}

const fail = (path: string, message: string): never => {
	throw new NoteFormatError(`${path}: ${message}`);
};
const object = (value: unknown, path: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail(path, "expected an object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		return fail(path, "expected plain JSON");
	return value as Record<string, unknown>;
};
const keys = (
	value: Record<string, unknown>,
	allowed: string[],
	path: string,
) => {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) fail(path, `unsupported field “${key}”`);
};
const string = (
	value: unknown,
	path: string,
	max = NOTE_LIMITS.text,
): string => {
	if (typeof value !== "string") return fail(path, "expected text");
	if (value.length > max) return fail(path, `text exceeds ${max} characters`);
	if (/[\uD800-\uDFFF]/u.test(value))
		return fail(path, "unpaired UTF-16 surrogates are not portable Unicode");
	return value;
};
const number = (
	value: unknown,
	path: string,
	min: number,
	max: number,
): number => {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max
	)
		return fail(path, `expected a number from ${min} to ${max}`);
	return value;
};
const boolean = (value: unknown, path: string): boolean =>
	typeof value === "boolean" ? value : fail(path, "expected true or false");
const choice = <T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
): T => {
	if (typeof value !== "string" || !allowed.includes(value as T))
		return fail(path, `expected ${allowed.join(", ")}`);
	return value as T;
};
const uuid = (value: unknown, path: string): string => {
	const result = string(value, path, 36);
	if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(result))
		return fail(path, "expected a component UUID");
	return result;
};

/** Validation, not URL rewriting: signed media URLs must retain their exact bytes. */
export function safeURL(value: unknown, allowMailto = false): string {
	const result = string(value, "URL", 8_192);
	if (/[\u0000-\u0020\u007f]/u.test(result))
		return fail("URL", "whitespace and control characters are not allowed");
	let parsed: URL;
	try {
		parsed = new URL(result);
	} catch {
		return fail("URL", "expected an absolute URL");
	}
	if (allowMailto && parsed.protocol === "mailto:") return result;
	if (
		!["https:", "http:"].includes(parsed.protocol) ||
		!parsed.hostname ||
		parsed.username ||
		parsed.password
	)
		return fail("URL", "only HTTP(S) URLs without credentials are supported");
	return result;
}

function paragraph(value: unknown, path: string): ParagraphStyle {
	const input = object(value, path);
	keys(input, ["kind", "list", "alignment"], path);
	const result: ParagraphStyle = {
		kind: choice(
			input.kind,
			["paragraph", "heading1", "heading2", "heading3", "quote"],
			`${path}.kind`,
		),
	};
	if (input.alignment !== undefined)
		result.alignment = choice(
			input.alignment,
			["left", "center", "right", "justified", "natural"] as const,
			`${path}.alignment`,
		);
	if (input.list !== undefined) {
		const list = object(input.list, `${path}.list`);
		keys(list, ["path", "checked", "start"], `${path}.list`);
		if (
			!Array.isArray(list.path) ||
			list.path.length < 1 ||
			list.path.length > 6
		)
			return fail(`${path}.list.path`, "expected one to six nesting levels");
		result.list = {
			path: list.path.map((kind, index) =>
				choice(
					kind,
					["bullet", "numbered", "task"],
					`${path}.list.path[${index}]`,
				),
			),
		};
		if (list.checked !== undefined)
			result.list.checked = boolean(list.checked, `${path}.list.checked`);
		if (list.start !== undefined) {
			const start = number(list.start, `${path}.list.start`, 1, 1_000_000);
			if (!Number.isInteger(start))
				return fail(`${path}.list.start`, "expected an integer");
			result.list.start = start;
		}
		if (result.list.checked !== undefined && result.list.path.at(-1) !== "task")
			return fail(`${path}.list.checked`, "checked state requires a task list");
		if (
			result.list.start !== undefined &&
			result.list.path.at(-1) !== "numbered"
		)
			return fail(
				`${path}.list.start`,
				"a starting number requires a numbered list",
			);
	}
	return result;
}

export function parseTextStyle(value: unknown): TextStyle {
	const input = object(value, "text style");
	keys(
		input,
		[
			"marks",
			"fontSize",
			"fontFamily",
			"foreground",
			"background",
			"paragraph",
		],
		"text style",
	);
	const result: TextStyle = {};
	if (input.marks !== undefined) {
		const marks = object(input.marks, "marks");
		keys(
			marks,
			["bold", "italic", "underline", "strike", "inlineCode", "link"],
			"marks",
		);
		const output: NonNullable<TextStyle["marks"]> = {};
		for (const key of [
			"bold",
			"italic",
			"underline",
			"strike",
			"inlineCode",
		] as const) {
			if (marks[key] !== undefined && boolean(marks[key], `marks.${key}`))
				output[key] = true;
		}
		if (marks.link !== undefined) output.link = safeURL(marks.link, true);
		if (Object.keys(output).length) result.marks = output;
	}
	if (input.fontSize !== undefined)
		result.fontSize = number(input.fontSize, "fontSize", 1, 512);
	if (input.fontFamily !== undefined) {
		const family = string(input.fontFamily, "fontFamily", 128);
		if (!/^[\p{L}\p{N} ._+\-]+$/u.test(family))
			return fail("fontFamily", "unsupported font family name");
		result.fontFamily = family;
	}
	for (const key of ["foreground", "background"] as const) {
		if (input[key] !== undefined) {
			const color = string(input[key], key, 9);
			if (
				!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color) &&
				!["text", "secondary", "muted"].includes(color)
			)
				return fail(key, "expected a hexadecimal or semantic text color");
			result[key] = color;
		}
	}
	if (input.paragraph !== undefined)
		result.paragraph = paragraph(input.paragraph, "paragraph");
	return result;
}

function drawing(value: unknown, path: string): DrawingDocument {
	const input = object(value, path);
	keys(input, ["elements"], path);
	if (!Array.isArray(input.elements) || input.elements.length > 2_000)
		return fail(path, "drawing must contain at most 2,000 elements");
	let pointCount = 0;
	const ids = new Set<string>();
	return {
		elements: input.elements.map((value, index) => {
			const at = `${path}.elements[${index}]`;
			const element = object(value, at);
			keys(element, ["id", "kind", "ink", "points", "text", "lineWidth"], at);
			const id = uuid(element.id, `${at}.id`);
			if (ids.has(id.toLowerCase()))
				return fail(at, "duplicate drawing element ID");
			ids.add(id.toLowerCase());
			if (
				!Array.isArray(element.points) ||
				(pointCount += element.points.length) > 100_000
			)
				return fail(at, "drawing exceeds 100,000 points");
			return {
				id,
				kind: choice(
					element.kind,
					["pen", "rectangle", "ellipse", "arrow", "text"],
					`${at}.kind`,
				),
				ink: choice(
					element.ink,
					["graphite", "blue", "purple", "orange", "green", "red"],
					`${at}.ink`,
				),
				points: element.points.map((value, index) => {
					const point = object(value, `${at}.points[${index}]`);
					keys(point, ["x", "y"], `${at}.points[${index}]`);
					return {
						x: number(point.x, "point.x", -100_000, 100_000),
						y: number(point.y, "point.y", -100_000, 100_000),
					};
				}),
				text: string(element.text, `${at}.text`, 100_000),
				lineWidth: number(element.lineWidth, `${at}.lineWidth`, 0.1, 100),
			};
		}),
	};
}

function metadata(value: unknown): LinkMetadata {
	const input = object(value, "metadata");
	keys(
		input,
		["title", "summary", "imageURL", "playback", "discoveryNote"],
		"metadata",
	);
	const result: LinkMetadata = {
		title: string(input.title, "metadata.title", 10_000),
	};
	if (input.summary !== undefined)
		result.summary = string(input.summary, "metadata.summary", 100_000);
	if (input.discoveryNote !== undefined)
		result.discoveryNote = string(
			input.discoveryNote,
			"metadata.discoveryNote",
			10_000,
		);
	if (input.imageURL !== undefined) result.imageURL = safeURL(input.imageURL);
	if (input.playback !== undefined) {
		const playback = object(input.playback, "metadata.playback");
		const variants = Object.keys(playback);
		if (
			variants.length !== 1 ||
			!["directVideo", "embedURL"].includes(variants[0])
		)
			return fail("metadata.playback", "expected directVideo or embedURL");
		const payload = object(playback[variants[0]], "metadata.playback payload");
		keys(payload, ["_0"], "metadata.playback payload");
		result.playback = {
			[variants[0]]: { _0: safeURL(payload._0) },
		} as Playback;
	}
	return result;
}

export function parseComponent(value: unknown): Component {
	const input = object(value, "component");
	keys(
		input,
		["id", "kind", "title", "source", "svg", "drawing", "metadata"],
		"component",
	);
	const result: Component = {
		id: uuid(input.id, "component.id"),
		kind: choice(
			input.kind,
			["diagram", "mermaid", "drawing", "link"],
			"component.kind",
		),
		title: string(input.title, "component.title", 10_000),
		source: string(input.source, "component.source", 200_000),
	};
	if (result.kind === "link" && result.source) safeURL(result.source);
	if (input.svg !== undefined)
		result.svg = string(input.svg, "component.svg", 8 * 1024 * 1024);
	if (input.drawing !== undefined)
		result.drawing = drawing(input.drawing, "component.drawing");
	if (input.metadata !== undefined) result.metadata = metadata(input.metadata);
	return result;
}

/** Reject unsupported data before replacing a user's current draft. */
export function parseNote(value: unknown): PortableNote {
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > NOTE_LIMITS.bytes)
			return fail("note", "file exceeds 16 MiB");
		try {
			value = JSON.parse(value);
		} catch {
			return fail("note", "invalid JSON");
		}
	}
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		return fail("note", "expected finite, non-circular JSON");
	}
	if (
		!encoded ||
		new TextEncoder().encode(encoded).byteLength > NOTE_LIMITS.bytes
	)
		return fail("note", "file exceeds 16 MiB");
	const input = object(value, "note");
	if (input.version !== 2)
		return fail("note", `unsupported note version ${String(input.version)}`);
	keys(input, ["version", "segments"], "note");
	if (
		!Array.isArray(input.segments) ||
		input.segments.length > NOTE_LIMITS.segments
	)
		return fail("segments", "expected at most 20,000 segments");
	let textLength = 0;
	let componentCount = 0;
	const ids = new Set<string>();
	const segments = input.segments.map((value, index): Segment => {
		const at = `segments[${index}]`;
		const segment = object(value, at);
		if (segment.type === "text") {
			keys(
				segment,
				[
					"type",
					"text",
					"marks",
					"fontSize",
					"fontFamily",
					"foreground",
					"background",
					"paragraph",
				],
				at,
			);
			const { type: _type, text: _text, ...style } = segment;
			const text = string(segment.text, `${at}.text`);
			textLength += text.length;
			return { type: "text", text, ...parseTextStyle(style) };
		}
		if (segment.type === "code") {
			keys(segment, ["type", "language", "source"], at);
			const source = string(segment.source, `${at}.source`);
			textLength += source.length;
			return {
				type: "code",
				language: string(segment.language, `${at}.language`, 128),
				source,
			};
		}
		if (segment.type === "component") {
			keys(segment, ["type", "component"], at);
			const component = parseComponent(segment.component);
			if (ids.has(component.id.toLowerCase()))
				return fail(at, "duplicate component ID");
			ids.add(component.id.toLowerCase());
			if (++componentCount > NOTE_LIMITS.components)
				return fail("note", "exceeds 1,000 components");
			return { type: "component", component };
		}
		return fail(at, `unsupported segment type ${String(segment.type)}`);
	});
	if (textLength > NOTE_LIMITS.text)
		return fail("note", "text exceeds 4 Mi characters");
	return { version: 2, segments };
}

/** Normalize only equivalent neighboring text runs. No separators are added. */
export function canonicalNote(note: PortableNote): PortableNote {
	const result: Segment[] = [];
	for (const segment of parseNote(note).segments) {
		const previous = result.at(-1);
		if (segment.type === "text" && previous?.type === "text") {
			const { text: _a, ...a } = segment;
			const { text: _b, ...b } = previous;
			if (JSON.stringify(a) === JSON.stringify(b)) {
				previous.text += segment.text;
				continue;
			}
		}
		result.push(segment);
	}
	return { version: 2, segments: result };
}
