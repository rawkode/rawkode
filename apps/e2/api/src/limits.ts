import {
	type DocumentNode,
	type FragmentDefinitionNode,
	Kind,
	type SelectionSetNode,
} from "graphql";

/** Call only after GraphQL validation rejects fragment cycles and missing spreads. */
export const enforceQueryBudget = (
	document: DocumentNode,
	operationName?: string,
): void => {
	const fragments = new Map(
		document.definitions.filter((
			definition,
		): definition is FragmentDefinitionNode =>
			definition.kind === Kind.FRAGMENT_DEFINITION
		).map((fragment) => [fragment.name.value, fragment]),
	);
	const operations = document.definitions.filter((definition) =>
		definition.kind === Kind.OPERATION_DEFINITION
	);
	const selected = operationName
		? operations.find((operation) => operation.name?.value === operationName)
		: operations.length === 1
		? operations[0]
		: undefined;
	if (!selected || selected.operation !== "query") {
		throw new Error("Select one read-only query operation.");
	}
	let fields = 0;
	let cost = 0;
	const visit = (
		selection: SelectionSetNode,
		depth: number,
		multiplier: number,
	): void => {
		if (depth > 10) throw new Error("Query exceeds the depth limit.");
		for (const node of selection.selections) {
			if (node.kind === Kind.FRAGMENT_SPREAD) {
				visit(fragments.get(node.name.value)!.selectionSet, depth, multiplier);
				continue;
			}
			if (node.kind === Kind.INLINE_FRAGMENT) {
				visit(node.selectionSet, depth, multiplier);
				continue;
			}
			fields++;
			cost += multiplier;
			if (fields > 100 || cost > 5000) {
				throw new Error("Query exceeds the complexity limit.");
			}
			const factor =
				["googleAccounts", "githubAccounts"].includes(node.name.value)
					? 20
					: node.name.value === "records"
					? 100
					: node.name.value === "items"
					? 50
					: 1;
			if (node.selectionSet) {
				visit(node.selectionSet, depth + 1, multiplier * factor);
			}
		}
	};
	visit(selected.selectionSet, 1, 1);
};
