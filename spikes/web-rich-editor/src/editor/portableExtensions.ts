import {
	Extension,
	InputRule,
	Mark,
	mergeAttributes,
	Node,
} from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { parseTextStyle, type TextStyle } from "../lib/note";

const colorCSS = (value: string) =>
	({
		text: "var(--editor-text, #242424)",
		secondary: "var(--editor-secondary, #616161)",
		muted: "var(--editor-muted, #767676)",
	})[value] ?? value;

/** These attributes belong to the portable adapter, not copied HTML. */
export const PortableAttributes = Extension.create({
	name: "portableAttributes",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("portableBoundaries"),
				appendTransaction(transactions, previous, state) {
					if (!transactions.some((transaction) => transaction.docChanged))
						return null;
					const seen = new Set<string>();
					const transaction = state.tr;
					const split = transactions.some((update) =>
						update.steps.some((step) => {
							const value = step.toJSON();
							return (
								value.stepType === "replace" &&
								value.from === value.to &&
								value.structure &&
								value.slice?.openStart > 0
							);
						}),
					);
					if (split) {
						const mapping = new Mapping();
						for (const update of transactions)
							mapping.appendMapping(update.mapping);
						const retainedIDs = new Set<string>();
						state.doc.descendants((node) => {
							if (typeof node.attrs.portableBoundaryID === "string")
								retainedIDs.add(node.attrs.portableBoundaryID);
						});
						previous.doc.descendants((node, position) => {
							const id = node.attrs.portableBoundaryID;
							if (typeof id !== "string" || !retainedIDs.has(id)) return;
							const mapped = mapping.map(position, -1);
							const leading = transaction.doc.nodeAt(mapped);
							// Splitting at the start of a heading makes the new first block a
							// default paragraph and drops its attrs. Restore the incoming
							// boundary there before assigning the second half its new LF.
							if (
								!leading?.isTextblock ||
								leading.content.size ||
								leading.attrs.portableBoundaryID !== null
							)
								return;
							transaction.setNodeMarkup(mapped, undefined, {
								...leading.attrs,
								portableLeadingSeparator: node.attrs.portableLeadingSeparator,
								portableLeadingSeparatorStyle:
									node.attrs.portableLeadingSeparatorStyle,
								portableBoundaryID: id,
							});
						});
					}
					transaction.doc.descendants((node, position) => {
						if (!["paragraph", "heading", "codeBlock"].includes(node.type.name))
							return;
						const id = node.attrs.portableBoundaryID;
						if (typeof id !== "string") return;
						if (seen.has(id)) {
							transaction.setNodeMarkup(position, undefined, {
								...node.attrs,
								portableLeadingSeparator: "\n",
								portableLeadingSeparatorStyle: null,
								portableBoundaryID: crypto.randomUUID(),
							});
						} else seen.add(id);
					});
					return transaction.docChanged ? transaction : null;
				},
			}),
		];
	},
	addGlobalAttributes() {
		return [
			{
				types: ["listItem", "taskItem"],
				attributes: {
					portableStructural: {
						default: false,
						parseHTML: () => false,
						renderHTML: (attrs) =>
							attrs.portableStructural
								? { "data-portable-structural": "", style: "list-style: none;" }
								: {},
					},
				},
			},
			{
				types: ["paragraph", "heading", "codeBlock"],
				attributes: {
					portableLeadingSeparator: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableLeadingSeparatorStyle: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableBoundaryID: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableEmptyStyle: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableParagraphExplicit: {
						default: false,
						rendered: false,
						parseHTML: () => false,
					},
					portableListStartExplicit: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableTaskCheckedExplicit: {
						default: null,
						rendered: false,
						parseHTML: () => null,
					},
					portableStructural: {
						default: false,
						rendered: false,
						parseHTML: () => false,
					},
					portableKind: {
						default: null,
						parseHTML: () => null,
						renderHTML: (attrs) =>
							attrs.portableKind
								? { "data-portable-kind": attrs.portableKind }
								: {},
					},
					portableAlignment: {
						default: null,
						parseHTML: (element) => {
							const alignment = element.style.textAlign;
							return ["left", "right", "center", "justify"].includes(alignment)
								? alignment === "justify"
									? "justified"
									: alignment
								: null;
						},
						renderHTML: (attrs) =>
							attrs.portableAlignment
								? {
										style: `text-align: ${attrs.portableAlignment === "justified" ? "justify" : attrs.portableAlignment === "natural" ? "start" : attrs.portableAlignment}`,
									}
								: {},
					},
				},
			},
		];
	},
});

/** Preserve native visual typography without overriding semantic rich-text marks. */
export const PortableStyle = Mark.create({
	name: "portableStyle",
	addAttributes() {
		return Object.fromEntries(
			["fontSize", "fontFamily", "foreground", "background"].map((name) => [
				name,
				{ default: null, rendered: false, parseHTML: () => null },
			]),
		);
	},
	parseHTML() {
		return [];
	},
	renderHTML({ HTMLAttributes, mark }) {
		const candidate = Object.fromEntries(
			Object.entries(mark.attrs).filter(
				([, value]) => value !== null && value !== undefined,
			),
		);
		let style: TextStyle;
		try {
			style = parseTextStyle(candidate);
		} catch {
			style = {};
		}
		const rules: string[] = [];
		if (style.fontSize !== undefined)
			rules.push(`font-size: ${style.fontSize}px`);
		if (style.fontFamily) {
			// AppKit's private system font names aren't installed web fonts. Preserve
			// their file value while displaying the browser's native system family.
			const family = style.fontFamily.startsWith(".")
				? "system-ui"
				: `"${style.fontFamily}"`;
			rules.push(`font-family: ${family}, sans-serif`);
		}
		if (style.foreground) rules.push(`color: ${colorCSS(style.foreground)}`);
		if (style.background)
			rules.push(`background-color: ${colorCSS(style.background)}`);
		return [
			"span",
			mergeAttributes(
				HTMLAttributes,
				rules.length ? { style: rules.join("; ") } : {},
			),
			0,
		];
	},
});

/** Editable fallback for native code ranges sharing a paragraph with prose. */
export const PortableInlineCode = Node.create({
	name: "portableCode",
	group: "inline",
	inline: true,
	content: "text*",
	marks: "",
	code: true,
	defining: true,
	addAttributes() {
		return { language: { default: "", rendered: false } };
	},
	parseHTML() {
		return [];
	},
	renderHTML({ HTMLAttributes }) {
		return [
			"code",
			mergeAttributes(HTMLAttributes, {
				class: "portable-inline-code",
				style: "white-space: pre-wrap;",
				"data-portable-code": "",
			}),
			0,
		];
	},
});

// Native inline code can also be bold, linked or carry an explicit font. The
// default Tiptap code mark excludes every other mark and rejects such files.
export const PortableCodeMark = Code.extend({ excludes: "" });

function hasProtectedInlineContent(node: ProseMirrorNode): boolean {
	let protectedContent = false;
	node.descendants((child) => {
		if (child.isInline && !child.isText && child.type.name !== "hardBreak")
			protectedContent = true;
	});
	return protectedContent;
}

/** Changing a paragraph's style must never delete its diagram or inline code. */
export function canConvertSelectionToCode(
	state: Pick<EditorState, "doc" | "selection">,
): boolean {
	let allowed = true;
	state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
		if (node.isTextblock && hasProtectedInlineContent(node)) allowed = false;
	});
	return allowed;
}

export const PortableCodeBlock = CodeBlock.extend({
	addCommands() {
		return {
			setCodeBlock:
				(attributes) =>
				({ state, commands }) =>
					canConvertSelectionToCode(state) &&
					commands.setNode(this.name, attributes),
			toggleCodeBlock:
				(attributes) =>
				({ state, commands }) =>
					canConvertSelectionToCode(state) &&
					commands.toggleNode(this.name, "paragraph", attributes),
		};
	},
	addInputRules() {
		return (this.parent?.() ?? []).map(
			(rule) =>
				new InputRule({
					find: rule.find,
					undoable: rule.undoable,
					handler: (props) => {
						const start = props.state.doc.resolve(props.range.from);
						if (hasProtectedInlineContent(start.parent)) return null;
						const incoming = start.parent.attrs;
						const position = start.before();
						const result = rule.handler(props);
						const converted = props.state.tr.doc.nodeAt(position);
						if (converted?.type.name === this.name) {
							props.state.tr.setNodeMarkup(position, undefined, {
								...converted.attrs,
								portableLeadingSeparator: incoming.portableLeadingSeparator,
								portableLeadingSeparatorStyle:
									incoming.portableLeadingSeparatorStyle,
								portableBoundaryID: incoming.portableBoundaryID,
							});
						}
						return result;
					},
				}),
		);
	},
});

/** Disable StarterKit's code and codeBlock; this factory supplies compatible replacements. */
export function portableExtensions() {
	return [
		PortableAttributes,
		PortableStyle,
		PortableInlineCode,
		PortableCodeMark,
		PortableCodeBlock,
	];
}
