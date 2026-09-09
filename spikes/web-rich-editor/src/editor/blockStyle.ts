import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { canConvertSelectionToCode } from "./portableExtensions";

export type BlockStyle =
	"paragraph" | "heading1" | "heading2" | "heading3" | "quote" | "code";
interface Block {
	node: ProseMirrorNode;
	position: number;
}

function normalizedMarks(marks: readonly Mark[]): Mark[] {
	return marks.flatMap((mark) => {
		if (mark.type.name !== "portableStyle") return [mark];
		const { fontSize: _size, fontFamily: _family, ...remaining } = mark.attrs;
		const attrs = Object.fromEntries(
			Object.entries(remaining).filter(
				([, value]) => value !== null && value !== undefined,
			),
		);
		return Object.keys(attrs).length ? [mark.type.create(attrs)] : [];
	});
}

function normalizedBoundaryStyle(value: Record<string, unknown> | null) {
	if (!value) return null;
	const { fontSize: _size, fontFamily: _family, ...remaining } = value;
	return remaining;
}

function mappedBlock(
	transaction: Transaction,
	block: Block,
): { node: ProseMirrorNode; position: number } | undefined {
	// A position inside the content survives wrapper lifts and node-type changes;
	// the old node's outer position may instead map before a former list wrapper.
	const mapped = transaction.mapping.map(block.position + 1, 1);
	const resolved = transaction.doc.resolve(
		Math.min(mapped, transaction.doc.content.size),
	);
	for (let depth = resolved.depth; depth > 0; depth--) {
		const node = resolved.node(depth);
		if (node.isTextblock) return { node, position: resolved.before(depth) };
	}
}

/** An explicit style change, not background formatting of imported documents. */
export function applyBlockStyle(editor: Editor, style: BlockStyle): boolean {
	if (
		![
			"paragraph",
			"heading1",
			"heading2",
			"heading3",
			"quote",
			"code",
		].includes(style)
	)
		return false;
	if (style === "code" && !canConvertSelectionToCode(editor.state))
		return false;
	const blocks: Block[] = [];
	editor.state.doc.descendants((node, position) => {
		if (!node.isTextblock) return;
		if (node.attrs.portableStructural && !node.content.size) return false;
		blocks.push({ node, position });
		return false;
	});
	const { from, to } = editor.state.selection;
	const selected = blocks.filter(
		(block) =>
			block.position < to && block.position + block.node.nodeSize > from,
	);
	if (!selected.length) return false;
	const outgoing = selected.flatMap((block) => {
		const next = blocks[blocks.indexOf(block) + 1];
		return next ? [next] : [];
	});
	const typingMarks =
		editor.state.storedMarks ?? editor.state.selection.$from.marks();
	const chain = editor
		.chain()
		.command(({ tr }) => {
			for (const block of selected) {
				block.node.descendants((node, offset) => {
					if (node.type.name === "portableCode") return false;
					if (!node.isText) return;
					const start = block.position + offset + 1;
					const end = start + node.nodeSize;
					const next = normalizedMarks(node.marks);
					for (const mark of node.marks)
						if (!next.some((candidate) => candidate.eq(mark)))
							tr.removeMark(start, end, mark);
					for (const mark of next)
						if (!node.marks.some((candidate) => candidate.eq(mark)))
							tr.addMark(start, end, mark);
				});
			}
			return true;
		})
		.clearNodes();

	if (style === "quote") chain.setBlockquote();
	else if (style === "code") chain.setCodeBlock();
	else if (style.startsWith("heading"))
		chain.setHeading({ level: Number(style.at(-1)) as 1 | 2 | 3 });

	return chain
		.command(({ tr }) => {
			for (const block of selected) {
				const mapped = mappedBlock(tr, block);
				if (!mapped) return false;
				tr.setNodeMarkup(mapped.position, undefined, {
					...mapped.node.attrs,
					portableLeadingSeparator: block.node.attrs.portableLeadingSeparator,
					portableLeadingSeparatorStyle:
						block.node.attrs.portableLeadingSeparatorStyle,
					portableBoundaryID: block.node.attrs.portableBoundaryID,
					portableAlignment: block.node.attrs.portableAlignment,
					portableEmptyStyle: normalizedBoundaryStyle(
						block.node.attrs.portableEmptyStyle,
					),
					portableParagraphExplicit: true,
					portableStructural: false,
					portableKind: null,
				});
			}
			// The separator's marks belong to the paragraph before it, even though its
			// storage lives on the following node to keep joins lossless.
			for (const block of outgoing) {
				const mapped = mappedBlock(tr, block);
				if (mapped)
					tr.setNodeMarkup(mapped.position, undefined, {
						...mapped.node.attrs,
						portableLeadingSeparatorStyle: normalizedBoundaryStyle(
							mapped.node.attrs.portableLeadingSeparatorStyle,
						),
					});
			}
			if (tr.selection.empty && style !== "code")
				tr.setStoredMarks(normalizedMarks(typingMarks));
			return true;
		})
		.run();
}
