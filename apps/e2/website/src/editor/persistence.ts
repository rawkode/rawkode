import { EditorState, Selection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { NOTE_LIMITS, parseNote } from "@e2/documents/note";

/** Validate before replacement; a newly opened file gets its own undo history. */
export const loadDocument = (editor: Editor, input: unknown): void => {
	const note = parseNote(input);
	const doc = editor.schema.nodeFromJSON(note);
	doc.check();
	const previous = editor.state;
	const transaction = previous.tr.replaceWith(
		0,
		previous.doc.content.size,
		doc.content,
	)
		.setMeta("preventUpdate", true).setMeta("addToHistory", false);
	transaction.setSelection(Selection.atStart(transaction.doc)).setStoredMarks(
		null,
	);
	const nextState = EditorState.create({
		schema: editor.schema,
		doc: transaction.doc,
		selection: transaction.selection,
		plugins: previous.plugins,
	});

	// Vue's Editor caches state through this event. Updating only the view leaves
	// commands/getJSON reading the old note and the next transaction restores it.
	editor.emit("beforeTransaction", { editor, transaction, nextState });
	editor.view.updateState(nextState);
	editor.emit("transaction", { editor, transaction, appendedTransactions: [] });
	editor.emit("selectionUpdate", { editor, transaction });
	// The caller saves after assigning the new filename; do not emit an autosave
	// update while the replacement still has the previous document's identity.
};

export const saveDocument = (editor: Editor): string => {
	const note = parseNote(editor.getJSON());
	const pretty = JSON.stringify(note, null, 2);
	return new TextEncoder().encode(pretty).byteLength <= NOTE_LIMITS.bytes
		? pretty
		: JSON.stringify(note);
};
