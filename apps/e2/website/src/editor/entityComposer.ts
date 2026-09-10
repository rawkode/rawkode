import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { type CanonicalEntityReference, parseEntity } from "@e2/documents/note";

export type EntityComposerTrigger = "#" | "@";
export type EntityComposerMode = "selection" | "typed";

export interface EntityComposerMatch {
	trigger: EntityComposerTrigger;
	mode: EntityComposerMode;
	from: number;
	to: number;
	query: string;
	displayText: string;
}

export const canonicalEntityReference = (
	match: EntityComposerMatch,
	entity: { id: string; label: string },
): CanonicalEntityReference => ({
	version: 1,
	entityId: entity.id,
	fallbackLabel: entity.label,
	displayText: match.mode === "selection" ? match.displayText : entity.label,
	presentation: match.trigger === "@" ? "mention" : "link",
});

/** Legacy provider references remain readable, but new external insertions must be canonical. */
export const canonicalEntityInsertion = (
	value: unknown,
): CanonicalEntityReference => {
	const entity = parseEntity(value);
	if (!("version" in entity) || entity.version !== 1) {
		throw new Error("A canonical entity is required for new links.");
	}
	return entity;
};

export type LatestEntitySearchResult<T> =
	| { accepted: true; value: T }
	| { accepted: false };

/** Abort the previous request and reject any response that is no longer current. */
export const createLatestEntitySearch = <Input, Output>(
	search: (input: Input, signal: AbortSignal) => Promise<Output>,
) => {
	let generation = 0;
	let controller: AbortController | undefined;
	return {
		run: async (input: Input): Promise<LatestEntitySearchResult<Output>> => {
			const current = ++generation;
			controller?.abort();
			const nextController = new AbortController();
			controller = nextController;
			try {
				const value = await search(input, nextController.signal);
				return current === generation && !nextController.signal.aborted
					? { accepted: true, value }
					: { accepted: false };
			} catch (failure) {
				if (current !== generation || nextController.signal.aborted) {
					return { accepted: false };
				}
				throw failure;
			}
		},
		cancel: () => {
			generation++;
			controller?.abort();
			controller = undefined;
		},
	};
};

type EntityComposerMeta =
	| { type: "open"; match: EntityComposerMatch }
	| { type: "close" };

export const entityComposerKey = new PluginKey<EntityComposerMatch | null>(
	"entityComposer",
);

const excludedMarks = new Set(["code", "link"]);
const isExcludedTextblock = (node: ProseMirrorNode): boolean =>
	!node.isTextblock || node.type.name === "codeBlock";

const selectionHasExcludedContent = (
	state: EditorState,
	from: number,
	to: number,
): boolean => {
	let excluded = false;
	state.doc.nodesBetween(from, to, (node) => {
		if (
			node.type.name === "entity" ||
			node.marks.some((mark) => excludedMarks.has(mark.type.name))
		) {
			excluded = true;
			return false;
		}
	});
	return excluded;
};

/** A selected phrase can become one inline entity only within one textblock. */
export const selectedEntityMatch = (
	state: EditorState,
): EntityComposerMatch | null => {
	const { selection } = state;
	if (
		!(selection instanceof TextSelection) ||
		selection.empty ||
		!selection.$from.sameParent(selection.$to) ||
		isExcludedTextblock(selection.$from.parent) ||
		selectionHasExcludedContent(state, selection.from, selection.to)
	) return null;
	const displayText = state.doc.textBetween(
		selection.from,
		selection.to,
		"\n",
		"\ufffc",
	);
	const query = displayText.trim();
	if (!query || displayText.length > 1_000 || displayText.includes("\ufffc")) {
		return null;
	}
	return {
		trigger: "#",
		mode: "selection",
		from: selection.from,
		to: selection.to,
		query,
		displayText,
	};
};

const tokenPattern = /(?:^|[\s([{])([#@])([\p{L}\p{N}._ -]{0,64})$/u;

/** Derive a typed entity token after a document transaction. */
export const typedEntityMatch = (
	state: EditorState,
): EntityComposerMatch | null => {
	const { selection } = state;
	if (!selection.empty || isExcludedTextblock(selection.$from.parent)) {
		return null;
	}
	if (
		selection.$from.marks().some((mark) => excludedMarks.has(mark.type.name))
	) return null;
	const before = selection.$from.parent.textBetween(
		0,
		selection.$from.parentOffset,
		"\n",
		"\ufffc",
	);
	const token = tokenPattern.exec(before);
	if (!token) return null;
	const trigger = token[1] as EntityComposerTrigger;
	const rawQuery = token[2] ?? "";
	// StarterKit owns the Markdown heading shortcut. Never turn `# ` at the
	// beginning of a paragraph into an entity query.
	if (
		trigger === "#" &&
		selection.$from.parent.type.name === "paragraph" &&
		before === "# "
	) return null;
	const tokenText = `${trigger}${rawQuery}`;
	return {
		trigger,
		mode: "typed",
		from: selection.from - tokenText.length,
		to: selection.from,
		query: rawQuery.trim(),
		displayText: rawQuery.trim(),
	};
};

const mappedMatch = (
	match: EntityComposerMatch,
	transaction: Transaction,
): EntityComposerMatch | null => {
	const from = transaction.mapping.mapResult(match.from, 1);
	const to = transaction.mapping.mapResult(match.to, -1);
	return from.deletedAcross || to.deletedAcross || from.pos >= to.pos
		? null
		: { ...match, from: from.pos, to: to.pos };
};

const sameMatch = (
	left: EntityComposerMatch | null,
	right: EntityComposerMatch | null,
): boolean =>
	left === right || (!!left && !!right &&
		left.trigger === right.trigger && left.mode === right.mode &&
		left.from === right.from && left.to === right.to &&
		left.query === right.query && left.displayText === right.displayText);

export const closeEntityComposer = (transaction: Transaction): Transaction =>
	transaction.setMeta(
		entityComposerKey,
		{ type: "close" } satisfies EntityComposerMeta,
	);

export const openEntityComposer = (
	transaction: Transaction,
	match: EntityComposerMatch,
): Transaction =>
	transaction.setMeta(
		entityComposerKey,
		{ type: "open", match } satisfies EntityComposerMeta,
	);

export const reduceEntityComposer = (
	transaction: Transaction,
	previous: EntityComposerMatch | null,
	newState: EditorState,
): EntityComposerMatch | null => {
	const meta = transaction.getMeta(entityComposerKey) as
		| EntityComposerMeta
		| undefined;
	if (meta?.type === "open") return meta.match;
	if (meta?.type === "close") return null;
	if (previous?.mode === "selection") {
		const mapped = mappedMatch(previous, transaction);
		if (
			mapped && newState.selection.from === mapped.from &&
			newState.selection.to === mapped.to
		) return selectedEntityMatch(newState);
	}
	return typedEntityMatch(newState);
};

export interface EntityComposerOptions {
	onChange: (match: EntityComposerMatch | null) => void;
}

export const EntityComposer = Extension.create<EntityComposerOptions>({
	name: "entityComposer",
	priority: 1_000,
	addOptions: () => ({ onChange: () => {} }),
	addProseMirrorPlugins() {
		const onChange = this.options.onChange;
		return [
			new Plugin<EntityComposerMatch | null>({
				key: entityComposerKey,
				state: {
					init: (_config, state) => typedEntityMatch(state),
					apply: (transaction, previous, _oldState, newState) =>
						reduceEntityComposer(transaction, previous, newState),
				},
				props: {
					handleKeyDown: (view, event) => {
						if (
							event.key !== "#" || event.isComposing || event.metaKey ||
							event.ctrlKey || event.altKey
						) return false;
						const match = selectedEntityMatch(view.state);
						if (!match) return false;
						view.dispatch(openEntityComposer(view.state.tr, match));
						return true;
					},
				},
				view: (view) => {
					let previous = entityComposerKey.getState(view.state) ?? null;
					onChange(previous);
					return {
						update: (nextView) => {
							const next = entityComposerKey.getState(nextView.state) ?? null;
							if (!sameMatch(previous, next)) onChange(next);
							previous = next;
						},
						destroy: () => onChange(null),
					};
				},
			}),
		];
	},
});
