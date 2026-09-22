import { tool } from "ai";
import { z } from "zod";
import type { EntitiesApi } from "../../../packages/entities/src/index.ts";

export type VoiceEntityApi = Pick<
	EntitiesApi,
	"createEntity" | "getEntity" | "setUserValues"
>;
const id = z.string().min(1).max(200);
const value = z.union([
	z.string().max(8000),
	z.number().finite(),
	z.boolean(),
	z.array(z.string().max(2000)).max(32),
	z.array(z.number().finite()).max(32),
	z.array(z.boolean()).max(32),
]);
const values = z.record(id, value).refine(
	(input) => Object.keys(input).length <= 32,
	"At most 32 field values",
);
const uniqueIds = z.array(id).min(1).max(16).refine(
	(input) => new Set(input).size === input.length,
	"IDs must be unique",
);
const outputValues = z.record(id, value).refine(
	(input) => Object.keys(input).length <= 128,
	"At most 128 returned field values",
);
const entity = z.object({
	id,
	label: z.string().max(2000),
	bodyDocumentId: id,
	tagIds: z.array(id).max(64),
	revision: z.number().int().min(1),
	archived: z.boolean(),
	values: outputValues,
});
const createInput = z.object({
	label: z.string().trim().min(1).max(500),
	tagIds: uniqueIds,
	values: values.optional(),
	aliases: z.array(z.string().trim().min(1).max(200)).max(16).optional(),
}).strict();
const readInput = z.object({ id }).strict();
const updateInput = z.object({
	id,
	expectedRevision: z.number().int().min(1),
	values,
	clearFieldIds: z.array(id).max(32),
}).strict().refine(
	(input) => Object.keys(input.values).length + input.clearFieldIds.length > 0,
	"Provide a field change",
).refine(
	(input) =>
		input.clearFieldIds.every((key) => !Object.hasOwn(input.values, key)),
	"Cannot set and clear the same field",
);
const mutation = z.object({
	ok: z.boolean(),
	entity,
	conflicts: z.array(
		z.object({
			entityId: id,
			expectedRevision: z.number().int(),
			actualRevision: z.number().int(),
		}),
	).max(16),
});
const bounded = <T>(result: T): T => {
	if (new TextEncoder().encode(JSON.stringify(result)).length > 20000) {
		throw new Error("Entity result exceeds budget");
	}
	return result;
};
export const createVoiceEntityTools = (
	options: {
		owner: string;
		run<T>(
			write: boolean,
			action: (api: VoiceEntityApi) => Promise<T>,
		): Promise<unknown>;
	},
) => {
	const provenance = {
		actor: options.owner,
		cause: "voice-entity-request",
		rationale: "Entity change requested by the authenticated user.",
	};
	// The existing API has no durable request identity. Coalesce identical calls
	// within this turn only. The shared runner blocks further writes after an
	// unknown outcome; callers must never automatically retry across turns.
	const creations = new Map<string, Promise<unknown>>();
	return {
		entityCreate: tool({
			description:
				"Create an entity only on a direct user request, such as saving a web link. Read Supertag fields first; values keys are actual field IDs, not labels. Use the verified user tag and its URL field. Do not fetch the URL. Supply a clear label and optional aliases. Identical calls coalesce only within this turn; never retry unknown creation. Returns the persisted entity, not a promise of saving.",
			inputSchema: createInput,
			execute: async (input) => {
				const parsed = createInput.parse(input);
				const normalized = {
					...parsed,
					tagIds: [...parsed.tagIds].sort(),
					values: Object.fromEntries(
						Object.entries(parsed.values ?? {}).sort(([a], [b]) =>
							a.localeCompare(b)
						),
					),
					aliases: [...(parsed.aliases ?? [])].sort(),
				};
				const key = JSON.stringify(normalized);
				return await options.run(true, (api) => {
					let pending = creations.get(key);
					if (!pending) {
						pending = api.createEntity(normalized, provenance).then(
							(result) => {
								const saved = entity.parse(result);
								if (
									saved.label !== parsed.label || saved.archived ||
									!parsed.tagIds.every((tag) => saved.tagIds.includes(tag))
								) throw new Error("Created entity does not match request");
								return bounded({ entity: saved });
							},
						);
						creations.set(key, pending);
					}
					return pending;
				});
			},
		}),
		entityRead: tool({
			description:
				"Read an entity by its returned ID to verify saved fields and obtain its current revision before changing values.",
			inputSchema: readInput,
			execute: async (input) => {
				const parsed = readInput.parse(input);
				return await options.run(false, async (api) => {
					const saved = entity.nullable().parse(await api.getEntity(parsed.id));
					if (saved && saved.id !== parsed.id) {
						throw new Error("Entity identity mismatch");
					}
					return bounded({ entity: saved });
				});
			},
		}),
		entityUpdateValues: tool({
			description:
				"Set or explicitly clear entity field values on a direct user request, after reading current entity revision and tag fields. Cannot change tags. Rename through the schema's primary label field only when requested. ok:false is a conflict, never success. Never retry an uncertain write.",
			inputSchema: updateInput,
			execute: async (input) => {
				const parsed = updateInput.parse(input);
				return await options.run(true, async (api) => {
					const result = mutation.parse(
						await api.setUserValues(
							parsed.id,
							parsed.values,
							parsed.clearFieldIds,
							parsed.expectedRevision,
							provenance,
						),
					);
					if (
						result.entity.id !== parsed.id ||
						result.ok && result.conflicts.length ||
						!result.ok && !result.conflicts.length
					) throw new Error("Invalid entity mutation receipt");
					return bounded(result);
				});
			},
		}),
	};
};
