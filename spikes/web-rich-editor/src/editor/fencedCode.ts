import { Extension, InputRule } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import {
	EditorState,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { defaultComponent } from "../lib/component";
import type { PortableNote, Segment } from "../lib/note";
import { toEditorJSON } from "./adapter";

export interface CompletedFence {
	/** UTF-16 offsets, matching both JavaScript strings and ProseMirror positions. */
	from: number;
	to: number;
	language: string;
	source: string;
	fenceLength: number;
}

interface Line {
	from: number;
	contentEnd: number;
	to: number;
	text: string;
}
const openingPattern = /^ {0,3}(`{3,})([^`]*)$/u;
const closingPattern = /^ {0,3}(`{3,})[\t ]*$/u;
const openingInputPattern = /^ {0,3}(`{3,})([^`]*?)[\t ]$/u;

function lines(text: string): Line[] {
	const result: Line[] = [];
	const endings = /\r\n|\n|\r/gu;
	let from = 0;
	for (const match of text.matchAll(endings)) {
		result.push({
			from,
			contentEnd: match.index,
			to: match.index + match[0].length,
			text: text.slice(from, match.index),
		});
		from = match.index + match[0].length;
	}
	result.push({
		from,
		contentEnd: text.length,
		to: text.length,
		text: text.slice(from),
	});
	return result;
}

/** An unmatched opening, shorter closing marker, or inline fence remains literal. */
export function parseCompletedFences(text: string): CompletedFence[] {
	const result: CompletedFence[] = [];
	let opening: { line: Line; length: number; language: string } | undefined;
	for (const line of lines(text)) {
		if (opening) {
			const closing = closingPattern.exec(line.text);
			if (!closing || closing[1]!.length < opening.length) continue;
			// The line ending immediately before a closing fence is syntax. Every
			// other source byte, including CRLF, indentation and blank lines, survives.
			const source = text
				.slice(opening.line.to, line.from)
				.replace(/(?:\r\n|\r|\n)$/u, "");
			result.push({
				from: opening.line.from,
				to: line.contentEnd,
				language: opening.language,
				source,
				fenceLength: opening.length,
			});
			opening = undefined;
		} else {
			const match = openingPattern.exec(line.text);
			if (match && line.to > line.contentEnd)
				opening = {
					line,
					length: match[1]!.length,
					language: match[2]!.trim(),
				};
		}
	}
	return result;
}

function componentKind(language: string): "diagram" | "mermaid" | undefined {
	const token = language.trim().split(/\s/u)[0]?.toLowerCase();
	return token === "d2"
		? "diagram"
		: token === "mermaid"
			? "mermaid"
			: undefined;
}

/** Translate authoring syntax into the same portable nodes used by file import. */
export function fencedTextNote(text: string): PortableNote | undefined {
	const fences = parseCompletedFences(text);
	if (!fences.length) return undefined;
	const segments: Segment[] = [];
	let cursor = 0;
	for (const fence of fences) {
		if (cursor < fence.from)
			segments.push({ type: "text", text: text.slice(cursor, fence.from) });
		const kind = componentKind(fence.language);
		segments.push(
			kind
				? {
						type: "component",
						component: { ...defaultComponent(kind), source: fence.source },
					}
				: { type: "code", language: fence.language, source: fence.source },
		);
		cursor = fence.to;
	}
	if (cursor < text.length)
		segments.push({ type: "text", text: text.slice(cursor) });
	return { version: 2, segments };
}

function protectedSelection(state: EditorState): boolean {
	for (const position of [state.selection.$from, state.selection.$to]) {
		for (let depth = position.depth; depth > 0; depth--) {
			const node = position.node(depth);
			if (
				node.type.spec.code ||
				["codeBlock", "portableCode", "component"].includes(node.type.name)
			)
				return true;
		}
	}
	return Boolean(
		state.selection.$from.marks().some((mark) => mark.type.spec.code),
	);
}

function leadingBoundary(node: PMNode) {
	return {
		portableLeadingSeparator: node.attrs.portableLeadingSeparator,
		portableLeadingSeparatorStyle: node.attrs.portableLeadingSeparatorStyle,
		portableBoundaryID: node.attrs.portableBoundaryID,
	};
}

/** One paste transaction. Paragraph edges join surrounding prose; code edges don't. */
export function createFencedPasteTransaction(
	state: EditorState,
	text: string,
): Transaction | undefined {
	if (protectedSelection(state)) return undefined;
	const note = fencedTextNote(text);
	if (!note) return undefined;
	const document = state.schema.nodeFromJSON(toEditorJSON(note));
	document.check();
	const slice = new Slice(
		document.content,
		document.firstChild?.type.name === "paragraph" ? 1 : 0,
		document.lastChild?.type.name === "paragraph" ? 1 : 0,
	);
	return closeHistory(state.tr)
		.replaceSelection(slice)
		.setMeta("paste", true)
		.setMeta("uiEvent", "paste")
		.scrollIntoView();
}

function fencedNode(
	state: EditorState,
	language: string,
	source: string,
	original: PMNode,
): PMNode {
	const kind = componentKind(language);
	if (kind) {
		const component = state.schema.nodes.component!.create({
			component: { ...defaultComponent(kind), source },
		});
		return state.schema.nodes.paragraph!.create(
			leadingBoundary(original),
			component,
		);
	}
	return state.schema.nodes.codeBlock!.create(
		{ ...leadingBoundary(original), language, fenceAuthoringLength: 0 },
		source ? state.schema.text(source) : undefined,
	);
}

/** Enter opens an authored fence, or closes only a block this extension opened. */
export function createFenceEnterTransaction(
	state: EditorState,
): Transaction | undefined {
	const { $from, empty } = state.selection;
	if (!empty || $from.parentOffset !== $from.parent.content.size)
		return undefined;
	const parent = $from.parent;
	if (parent.type.name === "codeBlock") {
		const length = Number(parent.attrs.fenceAuthoringLength);
		if (!Number.isInteger(length) || length < 3) return undefined;
		const lastLine = lines(parent.textContent).at(-1)!;
		const closing = closingPattern.exec(lastLine.text);
		if (!closing || closing[1]!.length < length) return undefined;
		const source = parent.textContent
			.slice(0, lastLine.from)
			.replace(/(?:\r\n|\r|\n)$/u, "");
		const content = fencedNode(
			state,
			String(parent.attrs.language ?? ""),
			source,
			parent,
		);
		const after = state.schema.nodes.paragraph!.create();
		const from = $from.before();
		const container = $from.node(-1);
		if (
			!container.canReplace(
				$from.index(-1),
				$from.indexAfter(-1),
				Fragment.fromArray([content, after]),
			)
		)
			return undefined;
		const transaction = closeHistory(state.tr).replaceWith(
			from,
			from + parent.nodeSize,
			[content, after],
		);
		transaction.setSelection(
			TextSelection.create(transaction.doc, from + content.nodeSize + 1),
		);
		return transaction.scrollIntoView();
	}
	if (parent.type.name !== "paragraph" || protectedSelection(state))
		return undefined;
	// Never consume an attachment or inline code while recognizing an opener.
	let onlyText = true;
	parent.forEach((child) => {
		if (!child.isText) onlyText = false;
	});
	if (!onlyText) return undefined;
	const opening = openingPattern.exec(parent.textContent);
	if (!opening) return undefined;
	const type = state.schema.nodes.codeBlock;
	if (
		!type ||
		!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)
	)
		return undefined;
	const code = type.create({
		...leadingBoundary(parent),
		language: opening[2]!.trim(),
		fenceAuthoringLength: opening[1]!.length,
	});
	const from = $from.before();
	const transaction = closeHistory(state.tr).replaceWith(
		from,
		from + parent.nodeSize,
		code,
	);
	transaction.setSelection(TextSelection.create(transaction.doc, from + 1));
	return transaction.scrollIntoView();
}

/** Add to the editor and remove any blanket onUpdate fence conversion. */
export const FencedCodeAuthoring = Extension.create({
	name: "fencedCodeAuthoring",
	priority: 1_100,
	addGlobalAttributes() {
		return [
			{
				types: ["codeBlock"],
				attributes: {
					fenceAuthoringLength: {
						default: 0,
						rendered: false,
						parseHTML: () => 0,
					},
				},
			},
		];
	},
	addInputRules() {
		return [
			new InputRule({
				find: openingInputPattern,
				handler: ({ state, range, match }) => {
					const start = state.doc.resolve(range.from);
					const type = this.editor.schema.nodes.codeBlock!;
					if (
						start.parent.type.name !== "paragraph" ||
						start.parentOffset !== 0 ||
						range.to !== start.end() ||
						protectedSelection(state)
					)
						return null;
					let onlyText = true;
					start.parent.forEach((child) => {
						if (!child.isText) onlyText = false;
					});
					if (
						!onlyText ||
						!start
							.node(-1)
							.canReplaceWith(start.index(-1), start.indexAfter(-1), type)
					)
						return null;
					state.tr
						.delete(range.from, range.to)
						.setBlockType(range.from, range.from, type, {
							...leadingBoundary(start.parent),
							language: match[2]!.trim(),
							fenceAuthoringLength: match[1]!.length,
						});
				},
			}),
		];
	},
	addKeyboardShortcuts() {
		return {
			Enter: () => {
				const transaction = createFenceEnterTransaction(this.editor.state);
				if (!transaction) return false;
				this.editor.view.dispatch(transaction);
				return true;
			},
		};
	},
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("fieldnotesFencedPaste"),
				props: {
					handlePaste: (view, event) => {
						// Rich clipboard slices retain their formatting and component IDs
						// through the editor's own transformPasted hook instead.
						if (
							!event.clipboardData ||
							event.clipboardData.getData("text/html")
						)
							return false;
						try {
							const transaction = createFencedPasteTransaction(
								view.state,
								event.clipboardData.getData("text/plain"),
							);
							if (!transaction) return false;
							view.dispatch(transaction);
							return true;
						} catch {
							return false; /* Default paste keeps all literal source if conversion isn't representable. */
						}
					},
				},
			}),
		];
	},
});
