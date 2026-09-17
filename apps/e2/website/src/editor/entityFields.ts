import type { EntityFieldDefinition, EntityValue } from "../lib/supertags.ts";

const valueText = (value: EntityValue | undefined): string => {
	if (!value) return "Not set";
	for (
		const candidate of [
			value.text,
			value.number,
			value.boolean,
			value.strings,
			value.numbers,
			value.booleans,
		]
	) {
		if (candidate === null || candidate === undefined) continue;
		const text = Array.isArray(candidate)
			? candidate.join(", ")
			: String(candidate);
		return text.trim() ? text : "Not set";
	}
	return "Not set";
};

export const entityFieldRows = (
	fields: readonly Pick<EntityFieldDefinition, "id" | "label" | "archived">[],
	values: readonly EntityValue[],
): { id: string; label: string; text: string }[] => {
	const definitions = new Map(fields.map((field) => [field.id, field]));
	const saved = new Map(values.map((value) => [value.fieldId, value]));
	const ids = new Set([
		...fields.filter((field) => !field.archived).map((field) => field.id),
		...saved.keys(),
	]);
	return [...ids].map((id) => ({
		id,
		label: definitions.get(id)?.label || id,
		text: valueText(saved.get(id)),
	}));
};
