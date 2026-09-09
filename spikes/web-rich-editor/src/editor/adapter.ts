import type { JSONContent } from "@tiptap/core";
import {
	canonicalNote,
	NoteFormatError,
	parseNote,
	parseTextStyle,
	type ListKind,
	type ParagraphKind,
	type ParagraphStyle,
	type PortableNote,
	type Segment,
	type TextStyle,
} from "../lib/note";

interface Line {
	content: JSONContent[];
	paragraph?: ParagraphStyle;
	paragraphSeen?: boolean;
	separator: string;
	separatorStyle?: TextStyle;
	leadingSeparator?: string;
	leadingSeparatorStyle?: TextStyle;
	boundaryID?: string;
	emptyStyle?: TextStyle;
}
type TextSegment = Extract<Segment, { type: "text" }>;

const styleOf = ({
	type: _type,
	text: _text,
	...style
}: TextSegment): TextStyle => style;
const withoutParagraph = ({
	paragraph: _paragraph,
	...style
}: TextStyle): TextStyle => style;
const listNodeType = (kind: ListKind) =>
	({ bullet: "bulletList", numbered: "orderedList", task: "taskList" })[kind];
const listKind = (type?: string): ListKind | undefined =>
	({ bulletList: "bullet", orderedList: "numbered", taskList: "task" })[
		type ?? ""
	] as ListKind | undefined;
const isStructural = (node: JSONContent) =>
	node.attrs?.portableStructural === true;

function marksFor(style: TextStyle): NonNullable<JSONContent["marks"]> {
	const result: NonNullable<JSONContent["marks"]> = [];
	const marks = style.marks;
	for (const name of ["bold", "italic", "underline", "strike"] as const)
		if (marks?.[name]) result.push({ type: name });
	if (marks?.inlineCode) result.push({ type: "code" });
	if (marks?.link)
		result.push({
			type: "link",
			attrs: {
				href: marks.link,
				target: "_blank",
				rel: "noopener noreferrer nofollow",
			},
		});
	const { marks: _marks, paragraph: _paragraph, ...visual } = style;
	if (Object.keys(visual).length)
		result.push({ type: "portableStyle", attrs: visual });
	return result;
}

function textNode(text: string, style: TextStyle): JSONContent {
	const marks = marksFor(style);
	return { type: "text", text, ...(marks.length ? { marks } : {}) };
}

function linesFor(note: PortableNote): Line[] {
	const lines: Line[] = [];
	let line: Line = { content: [], separator: "" };
	const adoptParagraph = (style: TextStyle) => {
		if (
			line.paragraphSeen &&
			JSON.stringify(line.paragraph) !== JSON.stringify(style.paragraph)
		) {
			throw new NoteFormatError(
				"Conflicting paragraph metadata inside one paragraph cannot be represented without changing the note",
			);
		}
		line.paragraph = style.paragraph;
		line.paragraphSeen = true;
	};
	for (const segment of note.segments) {
		if (segment.type === "component") {
			line.content.push({
				type: "component",
				attrs: { component: segment.component },
			});
		} else if (segment.type === "code") {
			line.content.push({
				type: "portableCode",
				attrs: { language: segment.language },
				...(segment.source
					? { content: [{ type: "text", text: segment.source }] }
					: {}),
			});
		} else {
			const style = styleOf(segment);
			const pieces = segment.text.split(/(\r\n|\n|\r|\u2029|\u2028)/u);
			for (let index = 0; index < pieces.length; index++) {
				const piece = pieces[index];
				// An empty piece after a separator belongs to the next paragraph, whose
				// metadata must come from its own first run rather than the previous one.
				if (!piece && segment.text) continue;
				adoptParagraph(style);
				if (piece === "\u2028") {
					line.content.push({
						type: "hardBreak",
						...(marksFor(style).length ? { marks: marksFor(style) } : {}),
					});
				} else if (/^(?:\r\n|\n|\r|\u2029)$/u.test(piece)) {
					line.separator = piece;
					line.separatorStyle = withoutParagraph(style);
					lines.push(line);
					line = { content: [], separator: "" };
				} else if (piece) {
					line.content.push(textNode(piece, style));
				} else {
					line.emptyStyle = withoutParagraph(style);
				}
			}
		}
	}
	lines.push(line);
	return lines;
}

function blockFor(line: Line, inList: boolean): JSONContent {
	const attrs: Record<string, unknown> = {
		portableLeadingSeparator: line.leadingSeparator ?? "",
		portableLeadingSeparatorStyle: line.leadingSeparatorStyle ?? null,
		portableBoundaryID: line.boundaryID ?? null,
		portableEmptyStyle: line.emptyStyle ?? null,
		portableParagraphExplicit: !!line.paragraph,
		portableAlignment: line.paragraph?.alignment ?? null,
		portableListStartExplicit: line.paragraph?.list?.start !== undefined,
		portableTaskCheckedExplicit: line.paragraph?.list?.checked !== undefined,
	};
	const kind = line.paragraph?.kind ?? "paragraph";
	// Code is a real editable code block when it owns the paragraph. An inline
	// editable code node is necessary for native files with neighboring prose or
	// components; moving those neighbors onto new lines would corrupt the file.
	if (
		line.content.length === 1 &&
		line.content[0].type === "portableCode" &&
		!inList
	) {
		const code = line.content[0];
		return {
			type: "codeBlock",
			attrs: {
				...attrs,
				language: code.attrs?.language ?? "",
				portableKind: kind,
			},
			...(code.content ? { content: code.content } : {}),
		};
	}
	if (inList) {
		return {
			type: "paragraph",
			attrs: { ...attrs, portableKind: kind === "paragraph" ? null : kind },
			...(line.content.length ? { content: line.content } : {}),
		};
	}
	if (/^heading[123]$/.test(kind))
		return {
			type: "heading",
			attrs: { ...attrs, level: Number(kind.at(-1)) },
			...(line.content.length ? { content: line.content } : {}),
		};
	const paragraph: JSONContent = {
		type: "paragraph",
		attrs,
		...(line.content.length ? { content: line.content } : {}),
	};
	return kind === "quote"
		? { type: "blockquote", content: [paragraph] }
		: paragraph;
}

interface ListFrame {
	kind: ListKind;
	list: JSONContent;
	item?: JSONContent;
	nextNumber: number;
}

export function toEditorJSON(value: PortableNote): JSONContent {
	const note = parseNote(value);
	const content: JSONContent[] = [];
	let frames: ListFrame[] = [];
	const lines = linesFor(note);
	lines.forEach((line, index) => {
		line.leadingSeparator = lines[index - 1]?.separator ?? "";
		line.leadingSeparatorStyle = lines[index - 1]?.separatorStyle;
		line.boundaryID = `boundary-${index}`;
	});
	for (const line of lines) {
		const path = line.paragraph?.list?.path ?? [];
		if (!path.length) {
			frames = [];
			content.push(blockFor(line, false));
			continue;
		}
		let common = 0;
		while (
			common < path.length &&
			common < frames.length &&
			frames[common].kind === path[common]
		)
			common++;
		frames = frames.slice(0, common);
		// Ordered lists may deliberately restart. A separate list preserves that
		// displayed number rather than silently normalizing it to the previous one.
		const wanted =
			path.at(-1) === "numbered"
				? (line.paragraph?.list?.start ?? 1)
				: undefined;
		if (
			frames.length === path.length &&
			path.at(-1) === "numbered" &&
			wanted !== undefined &&
			wanted !== frames.at(-1)!.nextNumber
		)
			frames.pop();
		while (frames.length < path.length) {
			const depth = frames.length;
			const kind = path[depth];
			const start = depth === path.length - 1 ? (wanted ?? 1) : 1;
			const list: JSONContent = {
				type: listNodeType(kind),
				...(kind === "numbered" ? { attrs: { start } } : {}),
				content: [],
			};
			if (depth === 0) content.push(list);
			else {
				const parent = frames[depth - 1];
				if (!parent.item) {
					parent.item = {
						type: parent.kind === "task" ? "taskItem" : "listItem",
						attrs: {
							portableStructural: true,
							...(parent.kind === "task" ? { checked: false } : {}),
						},
						content: [
							{ type: "paragraph", attrs: { portableStructural: true } },
						],
					};
					parent.list.content!.push(parent.item);
					parent.nextNumber++;
				}
				parent.item.content!.push(list);
			}
			frames.push({ kind, list, nextNumber: start });
		}
		const frame = frames.at(-1)!;
		const item: JSONContent = {
			type: frame.kind === "task" ? "taskItem" : "listItem",
			...(frame.kind === "task"
				? { attrs: { checked: line.paragraph?.list?.checked ?? false } }
				: {}),
			content: [blockFor(line, true)],
		};
		frame.list.content!.push(item);
		frame.item = item;
		frame.nextNumber++;
	}
	return { type: "doc", content };
}

function styleForMarks(marks: JSONContent["marks"]): TextStyle {
	const result: TextStyle = {};
	const flags: NonNullable<TextStyle["marks"]> = {};
	for (const mark of marks ?? []) {
		if (["bold", "italic", "underline", "strike"].includes(mark.type))
			flags[mark.type as "bold" | "italic" | "underline" | "strike"] = true;
		else if (mark.type === "code") flags.inlineCode = true;
		else if (mark.type === "link") flags.link = mark.attrs?.href;
		else if (mark.type === "portableStyle") {
			const attrs = Object.fromEntries(
				Object.entries(mark.attrs ?? {}).filter(
					([, value]) => value !== null && value !== undefined,
				),
			);
			Object.assign(result, parseTextStyle(attrs));
		} else
			throw new NoteFormatError(
				`Unsupported editor mark “${mark.type}”; export stopped to preserve the draft`,
			);
	}
	if (Object.keys(flags).length) result.marks = flags;
	return parseTextStyle(result);
}

interface EditorLine {
	node: JSONContent;
	kind: ParagraphKind;
	list?: NonNullable<ParagraphStyle["list"]>;
}

function flatten(doc: JSONContent): EditorLine[] {
	if (doc.type !== "doc")
		throw new NoteFormatError("Expected an editor document");
	const lines: EditorLine[] = [];
	const visitBlock = (
		node: JSONContent,
		path: ListKind[] = [],
		item?: { checked?: boolean; start?: number },
		quoted = false,
	) => {
		const kind = listKind(node.type);
		if (kind) {
			const nextPath = [...path, kind];
			let number = node.attrs?.start ?? 1;
			for (const child of node.content ?? []) {
				if (child.type !== (kind === "task" ? "taskItem" : "listItem"))
					throw new NoteFormatError("Invalid list structure");
				let visibleParagraphs = 0;
				for (const block of child.content ?? []) {
					if (!listKind(block.type) && !isStructural(block))
						visibleParagraphs++;
					if (visibleParagraphs > 1)
						throw new NoteFormatError(
							"A list item contains multiple paragraphs. Split it into separate items, or use Shift-Enter for a soft line break, before exporting",
						);
					visitBlock(
						block,
						nextPath,
						kind === "task"
							? { checked: child.attrs?.checked ?? false }
							: kind === "numbered"
								? { start: number }
								: {},
						quoted,
					);
				}
				number++;
			}
			return;
		}
		if (node.type === "blockquote") {
			for (const child of node.content ?? [])
				visitBlock(child, path, item, true);
			return;
		}
		if (isStructural(node)) {
			// A formerly structural placeholder becomes real content as soon as the
			// user types in it; do not hide that edit during export.
			if (!node.content?.length) return;
		}
		if (!["paragraph", "heading", "codeBlock"].includes(node.type ?? ""))
			throw new NoteFormatError(
				`Unsupported editor block “${node.type}”; export stopped to preserve the draft`,
			);
		let paragraphKind: ParagraphKind = quoted ? "quote" : "paragraph";
		if (node.type === "heading") {
			const level = node.attrs?.level ?? 1;
			if (![1, 2, 3].includes(level))
				throw new NoteFormatError("Only heading levels 1–3 are portable");
			paragraphKind = `heading${level}` as ParagraphKind;
		} else if (!quoted && node.attrs?.portableKind)
			paragraphKind = node.attrs.portableKind;
		const list = path.length ? { path, ...item } : undefined;
		if (list?.start === 1 && node.attrs?.portableListStartExplicit === false)
			delete list.start;
		if (
			list?.checked === false &&
			node.attrs?.portableTaskCheckedExplicit === false
		)
			delete list.checked;
		lines.push({ node, kind: paragraphKind, list });
	};
	for (const node of doc.content ?? []) visitBlock(node);
	return lines;
}

function textContent(node: JSONContent): string {
	let result = "";
	for (const child of node.content ?? []) {
		if (child.type !== "text" || child.marks?.length)
			throw new NoteFormatError(
				"Code contains unsupported rich content; export stopped to preserve the draft",
			);
		result += child.text ?? "";
	}
	return result;
}

export function fromEditorJSON(doc: JSONContent): PortableNote {
	const segments: Segment[] = [];
	const lines = flatten(doc);
	const seenBoundaries = new Set<string>();
	const boundaries = lines.map(({ node }) => {
		const id = node.attrs?.portableBoundaryID;
		// ProseMirror copies a paragraph's attributes when splitting it in the
		// middle. Only the first occurrence owns the imported boundary; subsequent
		// occurrences are newly authored Enter boundaries, not copies of old CRLFs.
		const duplicate = typeof id === "string" && seenBoundaries.has(id);
		if (typeof id === "string") seenBoundaries.add(id);
		const candidate = node.attrs?.portableLeadingSeparator;
		return {
			separator:
				!duplicate &&
				typeof candidate === "string" &&
				/^(?:\r\n|\n|\r|\u2029)$/u.test(candidate)
					? candidate
					: "\n",
			style: parseTextStyle(
				duplicate ? {} : (node.attrs?.portableLeadingSeparatorStyle ?? {}),
			),
		};
	});
	lines.forEach(({ node, kind, list }, index) => {
		const paragraph: ParagraphStyle | undefined =
			kind !== "paragraph" ||
			list ||
			node.attrs?.portableParagraphExplicit ||
			node.attrs?.portableAlignment
				? {
						kind,
						...(list ? { list } : {}),
						...(node.attrs?.portableAlignment
							? { alignment: node.attrs.portableAlignment }
							: {}),
					}
				: undefined;
		const addText = (text: string, style: TextStyle) =>
			segments.push({
				type: "text",
				text,
				...style,
				...(paragraph ? { paragraph } : {}),
			});
		if (node.type === "codeBlock") {
			segments.push({
				type: "code",
				language: node.attrs?.language ?? "",
				source: textContent(node),
			});
		} else {
			for (const child of node.content ?? []) {
				if (child.type === "text")
					addText(child.text ?? "", styleForMarks(child.marks));
				else if (child.type === "hardBreak")
					addText("\u2028", styleForMarks(child.marks));
				else if (child.type === "component")
					segments.push({
						type: "component",
						component: child.attrs?.component,
					});
				else if (child.type === "portableCode")
					segments.push({
						type: "code",
						language: child.attrs?.language ?? "",
						source: textContent(child),
					});
				else
					throw new NoteFormatError(
						`Unsupported inline node “${child.type}”; export stopped to preserve the draft`,
					);
			}
			if (
				index === lines.length - 1 &&
				!node.content?.length &&
				(node.attrs?.portableEmptyStyle || paragraph)
			)
				addText("", parseTextStyle(node.attrs?.portableEmptyStyle ?? {}));
		}
		// A boundary belongs to the following paragraph. Joining paragraphs keeps
		// the first paragraph's attrs, which must not overwrite the next untouched
		// boundary (for example, joining before CRLF/LF mixed line endings).
		if (index < lines.length - 1) {
			const boundary = boundaries[index + 1];
			addText(boundary.separator, boundary.style);
		}
	});
	return canonicalNote({ version: 2, segments });
}
