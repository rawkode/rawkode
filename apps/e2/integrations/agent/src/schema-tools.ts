import { tool } from "ai";
import { z } from "zod";
import type { EntitiesApi } from "../../../packages/entities/src/index.ts";

export type VoiceSchemaApi = Pick<
	EntitiesApi,
	"getTag" | "defineField" | "updateField"
>;
const id = z.string().min(1).max(200);
const value = z.union([
	z.string().max(8000),
	z.number().finite(),
	z.boolean(),
	z.array(z.string().max(2000)).max(64),
	z.array(z.number().finite()).max(64),
	z.array(z.boolean()).max(64),
]);
const metadata = {
	label: z.string().trim().min(1).max(100),
	required: z.boolean().optional(),
	options: z.array(z.string().trim().min(1).max(200)).min(1).max(64).optional(),
	defaultValue: value.optional(),
};
const field = z.object({
	id,
	tagId: id,
	key: z.string().max(200),
	label: z.string().max(100),
	type: z.string().max(40),
	cardinality: z.enum(["single", "multiple"]),
	required: z.boolean(),
	options: z.array(z.string().max(200)).max(1000).optional(),
	defaultValue: z.union([
		z.string().max(100_000),
		z.number().finite(),
		z.boolean(),
		z.array(z.string().max(100_000)).max(1000),
		z.array(z.number().finite()).max(1000),
		z.array(z.boolean()).max(1000),
	]).optional(),
	archived: z.boolean(),
});
// Only known transactional rejections are reported as rejected; transport failures
// remain unknown through the shared runner, preventing accidental duplicate writes.
const mutate = async (action: () => Promise<unknown>) => {
	let result;
	try {
		result = await action();
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message === "Tag revision conflict") {
			return {
				outcome: "conflict",
				message:
					"The Supertag changed. Read the current schema before another edit.",
			};
		}
		if (
			[
				"Fields may be added only to active user tags",
				"Only active user fields may be updated",
				"Inherited fields must be updated on their defining tag",
				"Required field would be missing on an existing entity",
				"Expected enum option",
				"Only enum fields accept nonempty options",
				"Enum options must be distinct",
				"Enum fields require options",
			].includes(message)
		) {
			return { outcome: "rejected", message };
		}
		throw error;
	}
	return { field: field.parse(result) };
};
export const createVoiceSchemaTools = (options: {
	owner: string;
	run<T>(
		write: boolean,
		action: (api: VoiceSchemaApi) => Promise<T>,
	): Promise<unknown>;
}) => {
	const provenance = {
		actor: options.owner,
		cause: "voice-schema-request",
		rationale:
			"Supertag field change requested by the authenticated user in voice.",
	};
	return {
		supertagFields: tool({
			description:
				"Read the Supertag's current revision and complete field definitions before creating or updating a field. Inherited fields must be edited at their origin tag. Locked base/integration tags cannot be edited.",
			inputSchema: z.object({ tagId: id }).strict(),
			execute: ({ tagId }) =>
				options.run(false, async (api) => {
					const details = await api.getTag(tagId);
					if (!details) return { tag: null };
					const result = z.object({
						tag: z.object({
							id,
							name: z.string().max(200),
							revision: z.number().int(),
							kind: z.enum(["base", "integration", "user"]),
							archived: z.boolean(),
						}),
						fields: z.array(
							field.extend({ originTagId: id, inherited: z.boolean() }),
						).max(128),
					}).parse(details);
					if (result.tag.id !== tagId) {
						throw new Error("Supertag identity mismatch");
					}
					return result;
				}),
		}),
		supertagFieldCreate: tool({
			description:
				"Create a field on an active user Supertag, only when directly requested. Read supertagFields first and use its revision. Do not repeat a failed or uncertain creation. This adds a definition, not an entity value.",
			inputSchema: z.object({
				tagId: id,
				expectedTagRevision: z.number().int().min(1),
				key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
				...metadata,
				type: z.enum([
					"text",
					"number",
					"boolean",
					"date",
					"datetime",
					"url",
					"email",
					"enum",
					"entityReference",
				]),
				cardinality: z.enum(["single", "multiple"]),
			}).strict(),
			execute: (input) =>
				options.run(
					true,
					(api) => mutate(() => api.defineField(input, provenance)),
				),
		}),
		supertagFieldUpdate: tool({
			description:
				"Update a directly owned user Supertag field's label, required flag, enum options or default only on a direct user request, after reading current schema. null clears a default. Omit unchanged properties. Key/type/cardinality cannot change. Existing values must remain valid. Never retry an uncertain write or claim a rejected edit succeeded.",
			inputSchema: z.object({
				id,
				tagId: id,
				expectedTagRevision: z.number().int().min(1),
				...metadata,
				label: metadata.label.optional(),
				defaultValue: value.nullable().optional(),
			}).strict().refine(
				(input) =>
					Object.keys(input).some((key) =>
						["label", "required", "options", "defaultValue"].includes(key)
					),
				"Provide a field change",
			),
			execute: (input) =>
				options.run(
					true,
					(api) => mutate(() => api.updateField(input, provenance)),
				),
		}),
	};
};
