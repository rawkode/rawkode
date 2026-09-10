export const MAX_PANES = 8;
export const MAX_PANE_QUERY_LENGTH = 2_048;

export type PaneDescriptor =
	| { kind: "document"; id: string }
	| { kind: "entity"; id: string };
export type PaneHistoryMode = "push" | "pop";

export type PaneParseResult =
	| { ok: true; panes: PaneDescriptor[] }
	| { ok: false; reason: string };

const documentId = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/;
const entityId =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const encodePane = (pane: PaneDescriptor): string =>
	`${pane.kind}:${pane.id}`;

export const decodePane = (value: string): PaneDescriptor | null => {
	if (value.startsWith("document:")) {
		const id = value.slice("document:".length);
		return documentId.test(id) ? { kind: "document", id } : null;
	}
	if (value.startsWith("entity:")) {
		const id = value.slice("entity:".length);
		return entityId.test(id) ? { kind: "entity", id: id.toLowerCase() } : null;
	}
	return null;
};

export const parsePaneStack = (params: URLSearchParams): PaneParseResult => {
	const values = params.getAll("pane");
	if (!values.length) return { ok: false, reason: "missing" };
	if (values.length > MAX_PANES) return { ok: false, reason: "too-many" };
	if (
		values.reduce(
			(length, value) => length + encodeURIComponent(value).length,
			0,
		) >
			MAX_PANE_QUERY_LENGTH
	) return { ok: false, reason: "too-long" };
	const panes = values.map(decodePane);
	if (panes.some((pane) => !pane)) return { ok: false, reason: "invalid" };
	const valid = panes as PaneDescriptor[];
	if (
		valid[0]?.kind !== "document" ||
		valid.slice(1).some((pane) => pane.kind !== "entity")
	) return { ok: false, reason: "invalid-order" };
	const keys = valid.map(encodePane);
	if (new Set(keys).size !== keys.length) {
		return { ok: false, reason: "duplicate" };
	}
	return { ok: true, panes: valid };
};

export const paneSearchParams = (
	current: URLSearchParams,
	panes: readonly PaneDescriptor[],
): URLSearchParams => {
	const next = new URLSearchParams(current);
	next.delete("pane");
	panes.forEach((pane) => next.append("pane", encodePane(pane)));
	return next;
};

const sameStack = (
	left: readonly PaneDescriptor[],
	right: readonly PaneDescriptor[],
): boolean =>
	left.length === right.length &&
	left.every((pane, index) => encodePane(pane) === encodePane(right[index]!));

export interface PaneNavigatorHooks {
	prepareForTransition: (
		current: readonly PaneDescriptor[],
		next: readonly PaneDescriptor[],
	) => Promise<boolean>;
	commit: (
		panes: readonly PaneDescriptor[],
		mode: PaneHistoryMode,
	) => void;
}

/** Serialize navigation so a slow save cannot reorder rapid URL transitions. */
export const createPaneNavigator = (
	initial: readonly PaneDescriptor[],
	hooks: PaneNavigatorHooks,
) => {
	let current = [...initial];
	let queue: Promise<unknown> = Promise.resolve();
	const transition = (
		next: readonly PaneDescriptor[],
		mode: PaneHistoryMode,
	): Promise<boolean> => {
		const target = [...next];
		const operation = queue.then(async () => {
			if (sameStack(current, target)) return true;
			if (!await hooks.prepareForTransition(current, target)) return false;
			current = target;
			hooks.commit([...current], mode);
			return true;
		});
		queue = operation.catch(() => undefined);
		return operation;
	};
	return {
		get panes(): readonly PaneDescriptor[] {
			return current;
		},
		openEntity: (sourceIndex: number, id: string) => {
			if (!Number.isInteger(sourceIndex) || sourceIndex < 0) {
				return Promise.resolve(false);
			}
			const entity = decodePane(`entity:${id}`);
			if (!entity || sourceIndex >= current.length) {
				return Promise.resolve(false);
			}
			const prefix = current.slice(0, sourceIndex + 1);
			const existing = prefix.findIndex((pane) =>
				encodePane(pane) === encodePane(entity)
			);
			const target = existing >= 0
				? prefix.slice(0, existing + 1)
				: [...prefix, entity];
			return target.length <= MAX_PANES
				? transition(target, "push")
				: Promise.resolve(false);
		},
		activate: (index: number) =>
			Number.isInteger(index) && index >= 0 && index < current.length
				? transition(current.slice(0, index + 1), "push")
				: Promise.resolve(false),
		restore: (panes: readonly PaneDescriptor[]) => transition(panes, "pop"),
	};
};
