import type {
	CanonicalEntity,
	Cardinality,
	DefineFieldInput,
	EntitiesApi,
	EntityMutationResult,
	EntitySource,
	FieldType,
	FieldValue,
	MutationProvenance,
} from "@e2/entities";
import type { ApiContext, IntegrationSchema } from "../../api/src/context.ts";

const read = async <T>(
	context: ApiContext,
	action: (api: EntitiesApi) => Promise<T>,
): Promise<T> => {
	context.consume();
	if (!context.env.ENTITIES_ADMIN) throw new Error("Entities are unavailable");
	using api = await context.env.ENTITIES_ADMIN.admin(context.identity.ownerId);
	return await action(api);
};

const boundedString = (value: unknown, name: string, max: number): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`Invalid ${name}`);
	}
	return value.trim();
};
const boundedList = (
	value: unknown,
	name: string,
	max: number,
): unknown[] => {
	if (!Array.isArray(value) || value.length > max) {
		throw new Error(`Invalid ${name}`);
	}
	return value;
};
const strings = (value: unknown, name: string, max = 64): string[] =>
	boundedList(value ?? [], name, max).map((entry) =>
		boundedString(entry, name, 2_000)
	);

type ValueInput = {
	fieldId?: unknown;
	text?: unknown;
	number?: unknown;
	boolean?: unknown;
	strings?: unknown;
	numbers?: unknown;
	booleans?: unknown;
};
const rawValue = (value: unknown): FieldValue => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid entity field value");
	}
	const input = value as ValueInput;
	const arms = ["text", "number", "boolean", "strings", "numbers", "booleans"]
		.filter((key) => (input as Record<string, unknown>)[key] !== undefined);
	if (arms.length !== 1) {
		throw new Error("Entity values require exactly one value");
	}
	const arm = arms[0]!;
	const candidate = (input as Record<string, unknown>)[arm];
	if (arm === "text") return boundedString(candidate, "field value", 100_000);
	if (arm === "number") {
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
			throw new Error("Invalid numeric value");
		}
		return candidate;
	}
	if (arm === "boolean") {
		if (typeof candidate !== "boolean") {
			throw new Error("Invalid boolean value");
		}
		return candidate;
	}
	const items = boundedList(candidate, "field values", 1_000);
	if (arm === "strings") {
		return items.map((item) => boundedString(item, "field value", 100_000));
	}
	if (arm === "numbers") {
		if (
			!items.every((item) => typeof item === "number" && Number.isFinite(item))
		) throw new Error("Invalid numeric values");
		return items as number[];
	}
	if (!items.every((item) => typeof item === "boolean")) {
		throw new Error("Invalid boolean values");
	}
	return items as boolean[];
};
const inputValue = (value: unknown): [string, FieldValue] => {
	const input = value as ValueInput;
	return [boundedString(input?.fieldId, "field ID", 200), rawValue(value)];
};
const inputValues = (value: unknown): Record<string, FieldValue> => {
	const entries = boundedList(value ?? [], "entity values", 128).map(
		inputValue,
	);
	if (new Set(entries.map(([fieldId]) => fieldId)).size !== entries.length) {
		throw new Error("Entity field values must be unique");
	}
	return Object.fromEntries(entries);
};

const outputValue = ([fieldId, value]: [string, FieldValue]) => ({
	fieldId,
	text: typeof value === "string" ? value : null,
	number: typeof value === "number" ? value : null,
	boolean: typeof value === "boolean" ? value : null,
	strings:
		Array.isArray(value) && (value.length === 0 || typeof value[0] === "string")
			? value
			: null,
	numbers:
		Array.isArray(value) && value.length > 0 && typeof value[0] === "number"
			? value
			: null,
	booleans:
		Array.isArray(value) && value.length > 0 && typeof value[0] === "boolean"
			? value
			: null,
});
const entity = (value: CanonicalEntity) => ({
	...value,
	values: Object.entries(value.values).map(outputValue),
});
const mutationResult = (value: EntityMutationResult) => ({
	...value,
	entity: entity(value.entity),
});
const provenance = (
	context: ApiContext,
	cause: string,
	rationale: string,
): MutationProvenance => ({
	actor: context.identity.ownerId,
	cause,
	rationale,
});
const input = (args: Record<string, unknown>): Record<string, unknown> => {
	if (
		!args.input || typeof args.input !== "object" || Array.isArray(args.input)
	) throw new Error("Invalid input");
	return args.input as Record<string, unknown>;
};

const fieldTypes: Record<string, FieldType> = {
	TEXT: "text",
	NUMBER: "number",
	BOOLEAN: "boolean",
	DATE: "date",
	DATETIME: "datetime",
	URL: "url",
	EMAIL: "email",
	ENUM: "enum",
	ENTITY_REFERENCE: "entityReference",
};
const cardinalities: Record<string, Cardinality> = {
	SINGLE: "single",
	MULTIPLE: "multiple",
};

export const entitiesGraphql: IntegrationSchema = {
	typeDefs: `
    extend type User {
      supertags: [Supertag!]!
      supertag(id: ID!): SupertagDetails
      supertagArchiveImpact(id: ID!): ArchiveImpact!
      entityFieldArchiveImpact(id: ID!): ArchiveImpact!
      entities(query: String!, rootId: ID, limit: Int = 20): [EntitySummary!]!
      entity(id: ID!): Entity
    }
    type Supertag { id: ID! name: String! kind: String! parentId: ID rootId: ID! depth: Int! revision: Int! archived: Boolean! }
    type SupertagDetails { tag: Supertag! fields: [EntityFieldDefinition!]! directEntityCount: Int! inheritedEntityCount: Int! activeChildTagCount: Int! }
    type ArchiveImpact { allowed: Boolean! entityCount: Int! descendantTagCount: Int! valueCount: Int! }
    type EntitySummary { id: ID! label: String! bodyDocumentId: ID! tagIds: [ID!]! rootId: ID! }
    type Entity { id: ID! label: String! bodyDocumentId: ID! bodyDocumentIds: [ID!]! mergedEntityIds: [ID!]! tagIds: [ID!]! values: [EntityValue!]! aliases: [String!]! archived: Boolean! revision: Int! redirectedTo: ID }
    type EntityRevisionConflict { entityId: ID! expectedRevision: Int! actualRevision: Int! }
    type EntityMutationResult { ok: Boolean! entity: Entity! conflicts: [EntityRevisionConflict!]! }
    type EntityValue { fieldId: ID! text: String number: Float boolean: Boolean strings: [String!] numbers: [Float!] booleans: [Boolean!] }
    type EntityFieldDefinition { id: ID! tagId: ID! key: String! label: String! type: String! cardinality: String! required: Boolean! options: [String!] defaultValue: EntityValue archived: Boolean! originTagId: ID! inherited: Boolean! }
    enum EntityFieldType { TEXT NUMBER BOOLEAN DATE DATETIME URL EMAIL ENUM ENTITY_REFERENCE }
    enum EntityCardinality { SINGLE MULTIPLE }
    input EntityRawValueInput { text: String number: Float boolean: Boolean strings: [String!] numbers: [Float!] booleans: [Boolean!] }
    input EntityValueInput { fieldId: ID! text: String number: Float boolean: Boolean strings: [String!] numbers: [Float!] booleans: [Boolean!] }
    input CreateUserTagInput { name: String! parentId: ID! }
    input RenameUserTagInput { id: ID! name: String! expectedRevision: Int! }
    input ArchiveUserTagInput { id: ID! expectedRevision: Int! }
    input ArchiveEntityFieldInput { id: ID! expectedTagRevision: Int! expectedValueCount: Int! }
    input DefineEntityFieldInput { tagId: ID! key: String! label: String! type: EntityFieldType! cardinality: EntityCardinality! required: Boolean = false options: [String!] defaultValue: EntityRawValueInput }
    input CreateEntityInput { label: String! tagIds: [ID!]! aliases: [String!] values: [EntityValueInput!] }
    input SetEntityValuesInput { id: ID! expectedRevision: Int! values: [EntityValueInput!]! clearFieldIds: [ID!]! }
    input EntitySourceInput { provider: String! connectionId: ID! resourceType: String! resourceId: ID! }
    input SetEntityPreferredSourceInput { id: ID! fieldId: ID! expectedRevision: Int! source: EntitySourceInput }
    input MergeEntitiesInput { fromId: ID! intoId: ID! expectedFromRevision: Int! expectedIntoRevision: Int! }
    type Mutation {
      createUserTag(input: CreateUserTagInput!): Supertag!
      renameUserTag(input: RenameUserTagInput!): SupertagDetails!
      archiveUserTag(input: ArchiveUserTagInput!): SupertagDetails!
      defineEntityField(input: DefineEntityFieldInput!): EntityFieldDefinition!
      archiveEntityField(input: ArchiveEntityFieldInput!): SupertagDetails!
      createEntity(input: CreateEntityInput!): Entity!
      setEntityValues(input: SetEntityValuesInput!): EntityMutationResult!
      setEntityPreferredSource(input: SetEntityPreferredSourceInput!): EntityMutationResult!
      mergeEntities(input: MergeEntitiesInput!): EntityMutationResult!
    }
  `,
	fields: {
		"User.supertags": (_source, _args, context) =>
			read(context, (api) => api.listTags()),
		"User.supertag": (_source, args, context) =>
			read(context, (api) => api.getTag(boundedString(args.id, "tag ID", 200))),
		"User.supertagArchiveImpact": (_source, args, context) =>
			read(
				context,
				(api) => api.getTagArchiveImpact(boundedString(args.id, "tag ID", 200)),
			),
		"User.entityFieldArchiveImpact": (_source, args, context) =>
			read(
				context,
				(api) =>
					api.getFieldArchiveImpact(boundedString(args.id, "field ID", 200)),
			),
		"EntityFieldDefinition.defaultValue": (source) => {
			const field = source as { id: string; defaultValue?: FieldValue };
			return field.defaultValue === undefined
				? null
				: outputValue([field.id, field.defaultValue]);
		},
		"EntityFieldDefinition.originTagId": (source) =>
			(source as { originTagId?: string; tagId: string }).originTagId ??
				(source as { tagId: string }).tagId,
		"EntityFieldDefinition.inherited": (source) =>
			(source as { inherited?: boolean }).inherited ?? false,
		"User.entities": (_source, args, context) =>
			read(context, (api) =>
				api.searchEntities(
					String(args.query ?? ""),
					{
						rootId: args.rootId === null || args.rootId === undefined
							? undefined
							: String(args.rootId) as never,
						limit: args.limit === undefined ? undefined : Number(args.limit),
					},
				)),
		"User.entity": async (_source, args, context) => {
			const result = await read(
				context,
				(api) => api.getEntity(String(args.id)),
			);
			return result ? entity(result) : null;
		},
		"Mutation.createUserTag": (_source, args, context) => {
			const value = input(args);
			return read(context, (api) =>
				api.createUserTag(
					{
						name: boundedString(value.name, "tag name", 100),
						parentId: boundedString(value.parentId, "parent tag", 200),
					},
					provenance(
						context,
						"graphql:create-user-tag",
						"Authenticated user created a Supertag.",
					),
				));
		},
		"Mutation.renameUserTag": (_source, args, context) => {
			const value = input(args);
			return read(context, (api) =>
				api.renameUserTag(
					boundedString(value.id, "tag ID", 200),
					boundedString(value.name, "tag name", 100),
					Number(value.expectedRevision),
					provenance(
						context,
						"graphql:rename-user-tag",
						"Authenticated user renamed a Supertag.",
					),
				));
		},
		"Mutation.archiveUserTag": (_source, args, context) => {
			const value = input(args);
			return read(context, (api) =>
				api.archiveUserTag(
					boundedString(value.id, "tag ID", 200),
					Number(value.expectedRevision),
					provenance(
						context,
						"graphql:archive-user-tag",
						"Authenticated user archived an unused Supertag.",
					),
				));
		},
		"Mutation.defineEntityField": (_source, args, context) => {
			const value = input(args),
				type = fieldTypes[String(value.type)],
				cardinality = cardinalities[String(value.cardinality)];
			if (!type || !cardinality) throw new Error("Invalid field definition");
			const definition: DefineFieldInput = {
				tagId: boundedString(value.tagId, "tag ID", 200),
				key: boundedString(value.key, "field key", 64),
				label: boundedString(value.label, "field label", 100),
				type,
				cardinality,
				required: value.required === true,
				options: strings(value.options, "field options", 100),
			};
			if (value.defaultValue) {
				definition.defaultValue = rawValue(value.defaultValue);
			}
			return read(
				context,
				(api) =>
					api.defineField(
						definition,
						provenance(
							context,
							"graphql:define-entity-field",
							"Authenticated user defined a Supertag field.",
						),
					),
			);
		},
		"Mutation.archiveEntityField": (_source, args, context) => {
			const value = input(args);
			return read(context, (api) =>
				api.archiveField(
					boundedString(value.id, "field ID", 200),
					Number(value.expectedTagRevision),
					Number(value.expectedValueCount),
					provenance(
						context,
						"graphql:archive-entity-field",
						"Authenticated user archived a Supertag field after reviewing its impact.",
					),
				));
		},
		"Mutation.createEntity": async (_source, args, context) => {
			const value = input(args);
			const result = await read(context, (api) =>
				api.createEntity(
					{
						label: boundedString(value.label, "entity label", 1_000),
						tagIds: strings(value.tagIds, "entity tags", 64),
						aliases: strings(value.aliases, "entity aliases", 64),
						values: inputValues(value.values),
					},
					provenance(
						context,
						"graphql:create-entity",
						"Authenticated user created an entity.",
					),
				));
			return entity(result);
		},
		"Mutation.setEntityValues": async (_source, args, context) => {
			const value = input(args);
			const result = await read(context, (api) =>
				api.setUserValues(
					boundedString(value.id, "entity ID", 200),
					inputValues(value.values),
					strings(value.clearFieldIds, "cleared field IDs", 128),
					Number(value.expectedRevision),
					provenance(
						context,
						"graphql:set-entity-values",
						"Authenticated user updated entity field values.",
					),
				));
			return mutationResult(result);
		},
		"Mutation.setEntityPreferredSource": async (_source, args, context) => {
			const value = input(args);
			let source: EntitySource | null = null;
			if (value.source) {
				const raw = value.source as Record<string, unknown>;
				source = {
					provider: boundedString(raw.provider, "source provider", 100),
					connectionId: boundedString(
						raw.connectionId,
						"source connection",
						500,
					),
					resourceType: boundedString(
						raw.resourceType,
						"source resource type",
						100,
					),
					resourceId: boundedString(
						raw.resourceId,
						"source resource ID",
						2_000,
					),
				};
			}
			const result = await read(context, (api) =>
				api.setPreferredSource(
					boundedString(value.id, "entity ID", 200),
					boundedString(value.fieldId, "field ID", 200),
					source,
					Number(value.expectedRevision),
					provenance(
						context,
						"graphql:set-entity-source",
						"Authenticated user changed entity source precedence.",
					),
				));
			return mutationResult(result);
		},
		"Mutation.mergeEntities": async (_source, args, context) => {
			const value = input(args);
			const result = await read(context, (api) =>
				api.mergeEntities(
					boundedString(value.fromId, "source entity ID", 200),
					boundedString(value.intoId, "target entity ID", 200),
					Number(value.expectedFromRevision),
					Number(value.expectedIntoRevision),
					provenance(
						context,
						"graphql:merge-entities",
						"Authenticated user merged duplicate entities.",
					),
				));
			return mutationResult(result);
		},
	},
};
