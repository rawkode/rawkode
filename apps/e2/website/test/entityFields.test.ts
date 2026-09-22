import { entityFieldRows } from "../src/editor/entityFields.ts";
import type { EntityValue } from "../src/lib/supertags.ts";

const value = (
	fieldId: string,
	fields: Partial<EntityValue> = {},
): EntityValue => ({
	fieldId,
	text: null,
	number: null,
	boolean: null,
	strings: null,
	numbers: null,
	booleans: null,
	...fields,
});
const assertEqual = (actual: unknown, expected: unknown) => {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
};
Deno.test("entity shows unset declared fields, deduplicates inherited definitions, and retains unknown saved fields", () => {
	assertEqual(
		entityFieldRows([
			{ id: "title", label: "Title", archived: false },
			{ id: "url", label: "Website", archived: false },
			{ id: "url", label: "Website", archived: false },
			{ id: "retired", label: "Retired", archived: true },
		], [
			value("title", { text: "Google.com" }),
			value("legacy", { text: "Saved" }),
		]),
		[
			{ id: "title", label: "Title", text: "Google.com" },
			{ id: "url", label: "Website", text: "Not set" },
			{ id: "legacy", label: "legacy", text: "Saved" },
		],
	);
});
Deno.test("entity empty values use Not set while preserving false and zero", () => {
	assertEqual(
		entityFieldRows([], [
			value("zero", { number: 0 }),
			value("false", { boolean: false }),
			value("empty", { text: " " }),
			value("array", { strings: [] }),
			value("null"),
			value("booleans", { booleans: [false] }),
		]).map((row) => row.text),
		["0", "false", "Not set", "Not set", "Not set", "false"],
	);
});
