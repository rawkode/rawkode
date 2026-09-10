import { InputRule, Node, type Attribute, type Attributes, type Editor, type Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import TextAlign from "@tiptap/extension-text-align";
import Link from "@tiptap/extension-link";
import { OrderedList } from "@tiptap/extension-list";
import type { z } from "zod";
import {
	TextStyle,
	FontFamily,
	FontSize,
	Color,
	BackgroundColor,
} from "@tiptap/extension-text-style";
import type { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { entityReferenceSchema, linkAttributesSchema, orderedListAttributesSchema, parseComponent, parseEntity, safeURL, textStyleAttributesSchema } from "../lib/note";

function validatedHTMLAttributes(attributes: Record<string, Attribute | undefined>, fields: Record<string, z.ZodType>, emptyToNull = false): Attributes {
	const normalized: Attributes = {};
	for (const [name, attribute] of Object.entries(attributes)) {
		if (!attribute) continue;
		const schema = fields[name];
		if (!schema) { normalized[name] = attribute; continue; }
		normalized[name] = {
			...attribute,
			parseHTML(element: HTMLElement) {
				const value = attribute.parseHTML ? attribute.parseHTML(element) : element.getAttribute(name);
				const result = schema.safeParse(emptyToNull && value === "" ? null : value);
				return result.success ? result.data ?? attribute.default ?? null : attribute.default ?? null;
			},
		};
	}
	return normalized;
}

// Clipboard HTML is not our saved document format. Keep supported styles, but
// discard unsupported CSS values and empty browser defaults before they become
// editor attributes. Saved-file validation remains strict and lossless.
function withSafeStyleParsing(extension: Extension): Extension {
	return extension.extend({
		addGlobalAttributes() {
			return (this.parent?.() ?? []).map((group) => ({
				...group,
				attributes: validatedHTMLAttributes(group.attributes, textStyleAttributesSchema.shape, true),
			}));
		},
	});
}

const SafeLink = Link.extend({
	addAttributes() {
		return validatedHTMLAttributes(this.parent?.() ?? {}, linkAttributesSchema.shape);
	},
});

const SafeOrderedList = OrderedList.extend({
	addAttributes() {
		return validatedHTMLAttributes(this.parent?.() ?? {}, orderedListAttributesSchema.shape);
	},
});

export const ComponentNode = Node.create({
	name: "component",
	group: "inline",
	inline: true,
	atom: true,
	draggable: true,
	marks: "",
	addAttributes: () => ({ component: { default: null } }),
	parseHTML: () => [
		{
			tag: "span[data-fieldnotes-component]",
			getAttrs: (element) => {
				try {
					return {
						component: parseComponent(
							JSON.parse((element as HTMLElement).dataset.fieldnotesComponent!),
						),
					};
				} catch {
					return false;
				}
			},
		},
	],
	renderHTML: ({ node }) => [
		"span",
		{ "data-fieldnotes-component": JSON.stringify(node.attrs.component) },
		node.attrs.component?.title ?? "Component",
	],
});

export const EntityNode = Node.create({
	name: "entity",
	group: "inline",
	inline: true,
	atom: true,
	draggable: true,
	selectable: true,
	marks: "",
	addAttributes: () => ({ entity: { default: null } }),
	parseHTML: () => [
		{
			tag: "span[data-fieldnotes-entity]",
			getAttrs: (element) => {
				try {
					return {
						entity: parseEntity(
							JSON.parse((element as HTMLElement).dataset.fieldnotesEntity!),
						),
					};
				} catch {
					return false;
				}
			},
		},
	],
	renderHTML: ({ node }) => {
		const entity = entityReferenceSchema.parse(node.attrs.entity);
		return [
			"span",
			{
				"data-fieldnotes-entity": JSON.stringify(entity),
				class: "fieldnotes-entity",
				contenteditable: "false",
			},
			entity.label,
		];
	},
});

function containsComponent(node: PMNode): boolean {
	let found = false;
	node.descendants((child) => {
		if (child.isInline && !child.isText && child.type.name !== "hardBreak")
			found = true;
	});
	return found;
}

export function canConvertSelectionToCode(
	state: Pick<EditorState, "doc" | "selection">,
): boolean {
	let allowed = true;
	state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
		if (node.isTextblock && containsComponent(node)) allowed = false;
	});
	return allowed;
}

// Standard code blocks contain text only. Refuse conversions that would discard
// a selected paragraph's component instead of letting ProseMirror drop it.
const SafeCodeBlock = CodeBlock.extend({
	addCommands() {
		return {
			setCodeBlock:
				(attrs) =>
				({ state, commands }) =>
					canConvertSelectionToCode(state) &&
					commands.setNode(this.name, attrs),
			toggleCodeBlock:
				(attrs) =>
				({ state, commands }) =>
					canConvertSelectionToCode(state) &&
					commands.toggleNode(this.name, "paragraph", attrs),
		};
	},
	addInputRules() {
		return (this.parent?.() ?? []).map(
			(rule) =>
				new InputRule({
					find: rule.find,
					undoable: rule.undoable,
					handler: (props) =>
						containsComponent(props.state.doc.resolve(props.range.from).parent)
							? null
							: rule.handler(props),
				}),
		);
	},
});

/** Shared by the running editor and schema/interop tests. No storage projection. */
export function documentExtensions(component = ComponentNode) {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
			code: false,
			codeBlock: false,
			horizontalRule: false,
			trailingNode: false,
			link: false,
			orderedList: false,
		}),
		SafeLink.configure({
			openOnClick: false,
			autolink: false,
			linkOnPaste: false,
			protocols: ["http", "https", "mailto"],
			isAllowedUri: (url) => {
				try { return !!safeURL(url, true); } catch { return false; }
			},
		}),
		SafeOrderedList,
		Code.extend({ excludes: "" }),
		SafeCodeBlock,
		TaskList,
		TaskItem.configure({ nested: true }),
		TextStyle,
		withSafeStyleParsing(FontFamily),
		withSafeStyleParsing(FontSize),
		withSafeStyleParsing(Color),
		withSafeStyleParsing(BackgroundColor),
		TextAlign.configure({
			types: ["paragraph", "heading"],
			defaultAlignment: null,
		}),
		component,
		EntityNode,
	];
}

export type BlockStyle =
	"paragraph" | "heading1" | "heading2" | "heading3" | "quote" | "code";

export function applyBlockStyle(editor: Editor, style: BlockStyle): boolean {
	if (style === "code" && !canConvertSelectionToCode(editor.state))
		return false;
	const chain = editor
		.chain()
		.command(({ tr, state }) => {
			state.doc.nodesBetween(
				state.selection.from,
				state.selection.to,
				(node, position) => {
					if (!node.isTextblock) return;
					node.descendants((child, offset) => {
						const mark = child.marks.find(
							(item) => item.type.name === "textStyle",
						);
						if (!child.isText || !mark) return;
						const from = position + offset + 1,
							to = from + child.nodeSize;
						tr.removeMark(from, to, mark);
						const attrs = { ...mark.attrs, fontFamily: null, fontSize: null };
						if (Object.values(attrs).some((value) => value !== null))
							tr.addMark(from, to, mark.type.create(attrs));
					});
					return false;
				},
			);
			tr.setStoredMarks(
				(state.storedMarks ?? state.selection.$from.marks()).flatMap((mark) => {
					if (mark.type.name !== "textStyle") return [mark];
					const attrs = { ...mark.attrs, fontFamily: null, fontSize: null };
					return Object.values(attrs).some((value) => value !== null)
						? [mark.type.create(attrs)]
						: [];
				}),
			);
			return true;
		})
		.clearNodes();
	if (style === "quote") return chain.setBlockquote().run();
	if (style === "code") return chain.setCodeBlock().run();
	if (style.startsWith("heading"))
		return chain.setHeading({ level: Number(style.at(-1)) as 1 | 2 | 3 }).run();
	return chain.run();
}
