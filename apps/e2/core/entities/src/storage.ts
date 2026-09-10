import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/durable-sqlite";
import {
	BASE_TAGS,
	type BaseTagId,
	type CanonicalEntity,
	type Cardinality,
	type CreateEntityInput,
	type CreateUserTagInput,
	type DefineFieldInput,
	type EntitySearchOptions,
	type EntitySource,
	type EntitySummary,
	type FieldDefinition,
	type FieldType,
	type FieldValue,
	INTEGRATION_TAGS,
	MAX_TAG_DEPTH,
	type MutationProvenance,
	type ProjectionBatch,
	type Supertag,
} from "@e2/entities";
import {
	auditEvents,
	entities,
	entityAliases,
	entityRedirects,
	entityTags,
	entityUserValues,
	fieldDefinitions,
	fieldSourcePreferences,
	sourceAliases,
	sourceObservations,
	supertags,
} from "../schema.ts";

export type EntityDatabase = ReturnType<typeof drizzle>;
type EntityExecutor = Pick<
	EntityDatabase,
	"delete" | "insert" | "select" | "update"
>;

const baseNames: Readonly<Record<BaseTagId, string>> = {
	[BASE_TAGS.person]: "Person",
	[BASE_TAGS.event]: "Event",
	[BASE_TAGS.company]: "Company",
	[BASE_TAGS.task]: "Task",
	[BASE_TAGS.project]: "Project",
	[BASE_TAGS.document]: "Document",
	[BASE_TAGS.place]: "Place",
	[BASE_TAGS.topic]: "Topic",
	[BASE_TAGS.conversation]: "Conversation",
	[BASE_TAGS.asset]: "Asset",
};

const integrationSeeds = [
	[INTEGRATION_TAGS.googleContact, "Google Contact", BASE_TAGS.person],
	[INTEGRATION_TAGS.googleEvent, "Google Event", BASE_TAGS.event],
	[INTEGRATION_TAGS.githubUser, "GitHub User", BASE_TAGS.person],
	[
		INTEGRATION_TAGS.githubOrganization,
		"GitHub Organization",
		BASE_TAGS.company,
	],
	[INTEGRATION_TAGS.githubRepository, "GitHub Repository", BASE_TAGS.project],
	[INTEGRATION_TAGS.githubIssue, "GitHub Issue", BASE_TAGS.task],
	[INTEGRATION_TAGS.githubPullRequest, "GitHub Pull Request", BASE_TAGS.task],
	[
		INTEGRATION_TAGS.githubDiscussion,
		"GitHub Discussion",
		BASE_TAGS.conversation,
	],
] as const;

type SeedField = readonly [
	string,
	BaseTagId,
	string,
	string,
	FieldType,
	Cardinality,
	boolean?,
];
const seedFields: readonly SeedField[] = [
	[
		"field:person:name",
		BASE_TAGS.person,
		"name",
		"Name",
		"text",
		"single",
		true,
	],
	[
		"field:person:aliases",
		BASE_TAGS.person,
		"aliases",
		"Aliases",
		"text",
		"multiple",
	],
	[
		"field:person:emails",
		BASE_TAGS.person,
		"emails",
		"Emails",
		"email",
		"multiple",
	],
	[
		"field:person:phones",
		BASE_TAGS.person,
		"phones",
		"Phones",
		"text",
		"multiple",
	],
	[
		"field:person:avatar",
		BASE_TAGS.person,
		"avatar",
		"Avatar",
		"url",
		"single",
	],
	[
		"field:person:companies",
		BASE_TAGS.person,
		"companies",
		"Companies",
		"entityReference",
		"multiple",
	],
	[
		"field:event:title",
		BASE_TAGS.event,
		"title",
		"Title",
		"text",
		"single",
		true,
	],
	[
		"field:event:start",
		BASE_TAGS.event,
		"start",
		"Start",
		"datetime",
		"single",
	],
	["field:event:end", BASE_TAGS.event, "end", "End", "datetime", "single"],
	[
		"field:event:timezone",
		BASE_TAGS.event,
		"timezone",
		"Timezone",
		"text",
		"single",
	],
	[
		"field:event:all_day",
		BASE_TAGS.event,
		"all_day",
		"All day",
		"boolean",
		"single",
	],
	[
		"field:event:attendees",
		BASE_TAGS.event,
		"attendees",
		"Attendees",
		"entityReference",
		"multiple",
	],
	[
		"field:event:location",
		BASE_TAGS.event,
		"location",
		"Location",
		"text",
		"single",
	],
	["field:event:url", BASE_TAGS.event, "url", "URL", "url", "single"],
	["field:event:status", BASE_TAGS.event, "status", "Status", "text", "single"],
	[
		"field:company:name",
		BASE_TAGS.company,
		"name",
		"Name",
		"text",
		"single",
		true,
	],
	[
		"field:company:domains",
		BASE_TAGS.company,
		"domains",
		"Domains",
		"text",
		"multiple",
	],
	[
		"field:company:people",
		BASE_TAGS.company,
		"people",
		"People",
		"entityReference",
		"multiple",
	],
	["field:company:url", BASE_TAGS.company, "url", "URL", "url", "single"],
	[
		"field:task:title",
		BASE_TAGS.task,
		"title",
		"Title",
		"text",
		"single",
		true,
	],
	["field:task:status", BASE_TAGS.task, "status", "Status", "text", "single"],
	[
		"field:task:due_date",
		BASE_TAGS.task,
		"due_date",
		"Due date",
		"date",
		"single",
	],
	[
		"field:task:assignees",
		BASE_TAGS.task,
		"assignees",
		"Assignees",
		"entityReference",
		"multiple",
	],
	[
		"field:task:project",
		BASE_TAGS.task,
		"project",
		"Project",
		"entityReference",
		"single",
	],
	["field:task:url", BASE_TAGS.task, "url", "URL", "url", "single"],
	[
		"field:project:name",
		BASE_TAGS.project,
		"name",
		"Name",
		"text",
		"single",
		true,
	],
	[
		"field:project:status",
		BASE_TAGS.project,
		"status",
		"Status",
		"text",
		"single",
	],
	[
		"field:project:start_date",
		BASE_TAGS.project,
		"start_date",
		"Start date",
		"date",
		"single",
	],
	[
		"field:project:end_date",
		BASE_TAGS.project,
		"end_date",
		"End date",
		"date",
		"single",
	],
	[
		"field:project:members",
		BASE_TAGS.project,
		"members",
		"Members",
		"entityReference",
		"multiple",
	],
	[
		"field:project:company",
		BASE_TAGS.project,
		"company",
		"Company",
		"entityReference",
		"single",
	],
	["field:project:url", BASE_TAGS.project, "url", "URL", "url", "single"],
	[
		"field:document:title",
		BASE_TAGS.document,
		"title",
		"Title",
		"text",
		"single",
		true,
	],
	["field:document:url", BASE_TAGS.document, "url", "URL", "url", "single"],
	[
		"field:document:authors",
		BASE_TAGS.document,
		"authors",
		"Authors",
		"entityReference",
		"multiple",
	],
	[
		"field:document:published_at",
		BASE_TAGS.document,
		"published_at",
		"Published",
		"datetime",
		"single",
	],
	["field:place:name", BASE_TAGS.place, "name", "Name", "text", "single", true],
	[
		"field:place:address",
		BASE_TAGS.place,
		"address",
		"Address",
		"text",
		"single",
	],
	[
		"field:place:latitude",
		BASE_TAGS.place,
		"latitude",
		"Latitude",
		"number",
		"single",
	],
	[
		"field:place:longitude",
		BASE_TAGS.place,
		"longitude",
		"Longitude",
		"number",
		"single",
	],
	["field:place:url", BASE_TAGS.place, "url", "URL", "url", "single"],
	["field:topic:name", BASE_TAGS.topic, "name", "Name", "text", "single", true],
	[
		"field:topic:aliases",
		BASE_TAGS.topic,
		"aliases",
		"Aliases",
		"text",
		"multiple",
	],
	[
		"field:topic:related_topics",
		BASE_TAGS.topic,
		"related_topics",
		"Related topics",
		"entityReference",
		"multiple",
	],
	[
		"field:conversation:title",
		BASE_TAGS.conversation,
		"title",
		"Title",
		"text",
		"single",
		true,
	],
	[
		"field:conversation:participants",
		BASE_TAGS.conversation,
		"participants",
		"Participants",
		"entityReference",
		"multiple",
	],
	[
		"field:conversation:started_at",
		BASE_TAGS.conversation,
		"started_at",
		"Started",
		"datetime",
		"single",
	],
	[
		"field:conversation:url",
		BASE_TAGS.conversation,
		"url",
		"URL",
		"url",
		"single",
	],
	["field:asset:name", BASE_TAGS.asset, "name", "Name", "text", "single", true],
	["field:asset:kind", BASE_TAGS.asset, "kind", "Kind", "text", "single"],
	["field:asset:url", BASE_TAGS.asset, "url", "URL", "url", "single"],
	[
		"field:asset:mime_type",
		BASE_TAGS.asset,
		"mime_type",
		"MIME type",
		"text",
		"single",
	],
	["field:asset:size", BASE_TAGS.asset, "size", "Size", "number", "single"],
];

const requiredText = (value: unknown, label: string, max = 1_000): string => {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`Invalid ${label}`);
	}
	return value.trim();
};
const fieldKey = (value: unknown): string => {
	const key = requiredText(value, "field key", 64);
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error("Invalid field key");
	return key;
};
const normalize = (value: string) => value.trim().toLocaleLowerCase();
const json = (value: unknown) => JSON.stringify(value);
const parseJSON = <T>(value: string): T => JSON.parse(value) as T;
const isUUID = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		.test(value);

const validateProvenance = (value: MutationProvenance): MutationProvenance => ({
	actor: requiredText(value?.actor, "mutation actor", 200),
	cause: requiredText(value?.cause, "mutation cause", 500),
	rationale: requiredText(value?.rationale, "mutation rationale", 2_000),
});

const tagView = (row: typeof supertags.$inferSelect): Supertag => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	parentId: row.parentId,
	rootId: row.rootId as BaseTagId,
	depth: row.depth,
	revision: row.revision,
	archived: row.archived,
});
const fieldView = (
	row: typeof fieldDefinitions.$inferSelect,
): FieldDefinition => ({
	id: row.id,
	tagId: row.tagId,
	key: row.key,
	label: row.label,
	type: row.type as FieldType,
	cardinality: row.cardinality as Cardinality,
	required: row.required,
	options: row.options ? parseJSON<string[]>(row.options) : undefined,
	defaultValue: row.defaultValue
		? parseJSON<FieldValue>(row.defaultValue)
		: undefined,
	archived: row.archived,
});

const scalar = (
	type: FieldType,
	value: unknown,
	options?: readonly string[],
) => {
	if (type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error("Expected number");
		}
		return value;
	}
	if (type === "boolean") {
		if (typeof value !== "boolean") throw new Error("Expected boolean");
		return value;
	}
	if (typeof value !== "string" || !value || value.length > 100_000) {
		throw new Error(`Expected ${type}`);
	}
	if (type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error("Expected date");
	}
	if (type === "datetime" && !Number.isFinite(Date.parse(value))) {
		throw new Error("Expected datetime");
	}
	if (type === "url") {
		const url = new URL(value);
		if (
			!["http:", "https:"].includes(url.protocol) || url.username ||
			url.password
		) throw new Error("Expected HTTP(S) URL");
	}
	if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
		throw new Error("Expected email");
	}
	if (type === "enum" && !options?.includes(value)) {
		throw new Error("Expected enum option");
	}
	if (type === "entityReference" && !isUUID(value)) {
		throw new Error("Expected entity UUID");
	}
	return type === "email" ? value.toLocaleLowerCase() : value;
};

const validateValue = (field: FieldDefinition, value: unknown): FieldValue => {
	if (field.cardinality === "multiple") {
		if (!Array.isArray(value) || value.length > 1_000) {
			throw new Error(`Invalid value for ${field.key}`);
		}
		const result = value.map((entry) =>
			scalar(field.type, entry, field.options)
		);
		return [
			...new Map(result.map((entry) => [json(entry), entry])).values(),
		] as FieldValue;
	}
	if (Array.isArray(value)) throw new Error(`Invalid value for ${field.key}`);
	return scalar(field.type, value, field.options) as FieldValue;
};

export const createEntityStore = (
	db: EntityDatabase,
	now = (): string => new Date().toISOString(),
	id = (): string => crypto.randomUUID(),
) => {
	const seed = () =>
		db.transaction((tx) => {
			const timestamp = now();
			for (const [baseId, name] of Object.entries(baseNames)) {
				tx.insert(supertags).values({
					id: baseId,
					name,
					kind: "base",
					parentId: null,
					rootId: baseId,
					depth: 0,
					createdAt: timestamp,
					updatedAt: timestamp,
				}).onConflictDoNothing().run();
			}
			for (const [tagId, name, rootId] of integrationSeeds) {
				tx.insert(supertags).values({
					id: tagId,
					name,
					kind: "integration",
					parentId: rootId,
					rootId,
					depth: 1,
					createdAt: timestamp,
					updatedAt: timestamp,
				}).onConflictDoNothing().run();
			}
			for (
				const [fieldId, tagId, key, label, type, cardinality, required = false]
					of seedFields
			) {
				tx.insert(fieldDefinitions).values({
					id: fieldId,
					tagId,
					key,
					label,
					type,
					cardinality,
					required,
					createdAt: timestamp,
				}).onConflictDoNothing().run();
			}
		});

	const audit = (
		tx: EntityExecutor,
		subjectType: string,
		subjectId: string,
		revision: number,
		provenance: MutationProvenance,
	) => {
		const p = validateProvenance(provenance);
		tx.insert(auditEvents).values({
			id: id(),
			subjectType,
			subjectId,
			revision,
			...p,
			createdAt: now(),
		}).run();
	};

	const tagRows = (tagIds: readonly string[]) => {
		if (
			!tagIds.length || tagIds.length > 64 ||
			new Set(tagIds).size !== tagIds.length
		) throw new Error("Select one or more distinct tags");
		const rows = db.select().from(supertags).where(
			inArray(supertags.id, [...tagIds]),
		).all();
		if (rows.length !== tagIds.length || rows.some((row) => row.archived)) {
			throw new Error("Unknown or archived tag");
		}
		const roots = new Set(rows.map((row) => row.rootId));
		if (roots.size !== 1) throw new Error("Entity tags must share one base");
		return rows;
	};

	const effectiveFields = (tagIds: readonly string[]): FieldDefinition[] => {
		const selected = tagRows(tagIds);
		const allTags = db.select().from(supertags).all();
		const byId = new Map(allTags.map((tag) => [tag.id, tag]));
		const ancestry = new Set<string>();
		for (const selectedTag of selected) {
			let current: typeof selectedTag | undefined = selectedTag;
			for (let depth = 0; current; depth++) {
				if (depth > MAX_TAG_DEPTH) {
					throw new Error("Tag inheritance exceeds maximum depth");
				}
				ancestry.add(current.id);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
		}
		const fields = db.select().from(fieldDefinitions).where(
			inArray(fieldDefinitions.tagId, [...ancestry]),
		).all().filter((field) => !field.archived).map(fieldView);
		const keys = new Map<string, string>();
		for (const field of fields) {
			const existing = keys.get(field.key);
			if (existing && existing !== field.id) {
				throw new Error(`Conflicting field key: ${field.key}`);
			}
			keys.set(field.key, field.id);
		}
		return fields;
	};

	const checkedValues = (
		fields: readonly FieldDefinition[],
		values: Readonly<Record<string, unknown>>,
	) => {
		const byId = new Map(fields.map((field) => [field.id, field]));
		const result: Record<string, FieldValue> = {};
		for (const [fieldId, value] of Object.entries(values)) {
			const field = byId.get(fieldId);
			if (!field) {
				throw new Error(`Field ${fieldId} is not defined by the entity tags`);
			}
			result[fieldId] = validateValue(field, value);
		}
		return result;
	};
	const withPrimaryLabel = (
		fields: readonly FieldDefinition[],
		values: Record<string, FieldValue>,
		label: string,
	) => {
		const primary = fields.find((field) =>
			field.required && field.cardinality === "single" &&
			field.type === "text" && ["name", "title"].includes(field.key)
		);
		if (primary && !(primary.id in values)) values[primary.id] = label;
		return values;
	};

	const resolveId = (entityId: string): string => {
		if (!isUUID(entityId)) throw new Error("Invalid entity ID");
		let current = entityId;
		const seen = new Set<string>();
		for (let depth = 0; depth <= 64; depth++) {
			if (seen.has(current)) throw new Error("Invalid entity redirect cycle");
			seen.add(current);
			const redirect = db.select().from(entityRedirects).where(
				eq(entityRedirects.fromEntityId, current),
			).get();
			if (!redirect) return current;
			current = redirect.toEntityId;
		}
		throw new Error("Entity redirect chain is too deep");
	};

	const getEntity = (requestedId: string): CanonicalEntity | null => {
		const entityId = resolveId(requestedId);
		const row = db.select().from(entities).where(eq(entities.id, entityId))
			.get();
		if (!row) return null;
		const tagIds = db.select({ tagId: entityTags.tagId }).from(entityTags)
			.where(eq(entityTags.entityId, entityId)).all().map((entry) =>
				entry.tagId
			);
		const fields = effectiveFields(tagIds);
		const user = new Map(
			db.select().from(entityUserValues).where(
				eq(entityUserValues.entityId, entityId),
			).all().map((
				entry,
			) => [entry.fieldId, parseJSON<FieldValue>(entry.value)]),
		);
		const observations = db.select().from(sourceObservations).where(
			and(
				eq(sourceObservations.entityId, entityId),
				eq(sourceObservations.active, true),
			),
		).orderBy(asc(sourceObservations.createdAt)).all();
		const preferences = new Map(
			db.select().from(fieldSourcePreferences).where(
				eq(fieldSourcePreferences.entityId, entityId),
			).all().map((preference) => [preference.fieldId, preference]),
		);
		const sourceValues = observations.map((observation) => ({
			observation,
			values: parseJSON<Record<string, FieldValue>>(observation.values),
		}));
		const values: Record<string, FieldValue> = {};
		for (const field of fields) {
			if (field.cardinality === "multiple") {
				const candidates = [
					...sourceValues.flatMap(({ values }) =>
						Array.isArray(values[field.id])
							? values[field.id] as FieldValue[]
							: []
					),
					...(Array.isArray(user.get(field.id))
						? user.get(field.id) as FieldValue[]
						: []),
				];
				if (candidates.length) {
					values[field.id] = [
						...new Map(candidates.map((value) => [json(value), value]))
							.values(),
					] as FieldValue;
				} else if (field.defaultValue !== undefined) {
					values[field.id] = field.defaultValue;
				}
				continue;
			}
			if (user.has(field.id)) values[field.id] = user.get(field.id)!;
			else {
				const preferred = preferences.get(field.id);
				const source = preferred &&
					sourceValues.find(({ observation, values: observed }) =>
						observation.provider === preferred.provider &&
						observation.connectionId === preferred.connectionId &&
						observation.resourceType === preferred.resourceType &&
						observation.resourceId === preferred.resourceId &&
						field.id in observed
					);
				const fallback = sourceValues.find(({ values }) => field.id in values);
				const selected = source ?? fallback;
				if (selected) values[field.id] = selected.values[field.id]!;
				else if (field.defaultValue !== undefined) {
					values[field.id] = field.defaultValue;
				}
			}
		}
		const aliases = [...new Map([
			...db.select().from(entityAliases).where(
				eq(entityAliases.entityId, entityId),
			).all().map((entry) => [entry.normalized, entry.alias] as const),
			...db.select({
				alias: sourceAliases.alias,
				normalized: sourceAliases.normalized,
			}).from(sourceAliases).innerJoin(
				sourceObservations,
				and(
					eq(sourceAliases.provider, sourceObservations.provider),
					eq(sourceAliases.connectionId, sourceObservations.connectionId),
					eq(sourceAliases.resourceType, sourceObservations.resourceType),
					eq(sourceAliases.resourceId, sourceObservations.resourceId),
				),
			).where(
				and(
					eq(sourceObservations.entityId, entityId),
					eq(sourceObservations.active, true),
				),
			).all().map((entry) => [entry.normalized, entry.alias] as const),
		]).values()];
		return {
			id: row.id,
			label: row.label,
			bodyDocumentId: row.bodyDocumentId,
			tagIds,
			values,
			aliases,
			archived: row.archived,
			revision: row.revision,
			...(requestedId === entityId ? {} : { redirectedTo: entityId }),
		};
	};

	const createEntityRows = (
		tx: EntityExecutor,
		input: CreateEntityInput,
		provenance: MutationProvenance,
		entityId = id(),
	) => {
		if (!isUUID(entityId)) throw new Error("Generated entity ID is invalid");
		const label = requiredText(input.label, "entity label");
		const fields = effectiveFields(input.tagIds);
		const values = withPrimaryLabel(
			fields,
			checkedValues(fields, input.values ?? {}),
			label,
		);
		for (const field of fields) {
			if (!(field.id in values) && field.defaultValue !== undefined) {
				values[field.id] = field.defaultValue;
			}
			if (field.required && !(field.id in values)) {
				throw new Error(`Missing required field: ${field.key}`);
			}
		}
		const timestamp = now();
		tx.insert(entities).values({
			id: entityId,
			label,
			normalizedLabel: normalize(label),
			bodyDocumentId: `entity:${entityId}`,
			createdAt: timestamp,
			updatedAt: timestamp,
		}).run();
		for (const tagId of input.tagIds) {
			tx.insert(entityTags).values({ entityId, tagId }).run();
		}
		for (const [fieldId, value] of Object.entries(values)) {
			tx.insert(entityUserValues).values({
				entityId,
				fieldId,
				value: json(value),
			}).run();
		}
		for (const alias of input.aliases ?? []) {
			const clean = requiredText(alias, "alias");
			tx.insert(entityAliases).values({
				entityId,
				alias: clean,
				normalized: normalize(clean),
			}).onConflictDoNothing().run();
		}
		audit(tx, "entity", entityId, 1, provenance);
		return entityId;
	};

	seed();
	return {
		listTags: () =>
			db.select().from(supertags).orderBy(asc(supertags.id)).all().map(tagView),
		searchEntities: (
			query: string,
			options: EntitySearchOptions = {},
		): EntitySummary[] => {
			if (typeof query !== "string" || query.length > 200) {
				throw new Error("Invalid entity query");
			}
			const needle = normalize(query), limit = options.limit ?? 20;
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
				throw new Error("Invalid entity search limit");
			}
			if (
				options.rootId &&
				!Object.values(BASE_TAGS).includes(options.rootId)
			) throw new Error("Invalid entity root");
			const candidates = needle
				? [
					...db.select({ id: entities.id }).from(entities).where(and(
						eq(entities.archived, false),
						gte(entities.normalizedLabel, needle),
						lt(entities.normalizedLabel, `${needle}\uffff`),
					)).orderBy(asc(entities.normalizedLabel)).limit(limit * 4).all()
						.map(({ id }) => id),
					...db.select({ entityId: entityAliases.entityId }).from(entityAliases)
						.where(and(
							gte(entityAliases.normalized, needle),
							lt(entityAliases.normalized, `${needle}\uffff`),
						)).orderBy(asc(entityAliases.normalized)).limit(limit * 4).all()
						.map(({ entityId }) => entityId),
					...db.select({ entityId: sourceObservations.entityId })
						.from(sourceAliases).innerJoin(
							sourceObservations,
							and(
								eq(sourceAliases.provider, sourceObservations.provider),
								eq(sourceAliases.connectionId, sourceObservations.connectionId),
								eq(sourceAliases.resourceType, sourceObservations.resourceType),
								eq(sourceAliases.resourceId, sourceObservations.resourceId),
							),
						).where(and(
							eq(sourceObservations.active, true),
							gte(sourceAliases.normalized, needle),
							lt(sourceAliases.normalized, `${needle}\uffff`),
						)).orderBy(asc(sourceAliases.normalized)).limit(limit * 4).all()
						.map(({ entityId }) => entityId),
				]
				: db.select({ id: entities.id }).from(entities)
					.where(eq(entities.archived, false))
					.orderBy(desc(entities.updatedAt), asc(entities.normalizedLabel))
					.limit(limit * 4).all().map(({ id }) => id);
			const results: EntitySummary[] = [];
			for (const candidate of new Set(candidates)) {
				const entity = getEntity(candidate);
				if (!entity || entity.archived) continue;
				const rootId = tagRows(entity.tagIds)[0]!.rootId as BaseTagId;
				if (options.rootId && rootId !== options.rootId) continue;
				results.push({
					id: entity.id,
					label: entity.label,
					bodyDocumentId: entity.bodyDocumentId,
					tagIds: entity.tagIds,
					rootId,
				});
				if (results.length === limit) break;
			}
			return results;
		},
		createUserTag: (
			input: CreateUserTagInput,
			provenance: MutationProvenance,
		): Supertag =>
			db.transaction((tx) => {
				const parentId = requiredText(input.parentId, "parent tag", 200);
				const parent = tx.select().from(supertags).where(
					eq(supertags.id, parentId),
				).get();
				if (
					!parent || parent.archived || parent.kind === "integration"
				) throw new Error("User tags may extend a base or user tag");
				if (parent.depth + 1 > MAX_TAG_DEPTH) {
					throw new Error("Tag inheritance exceeds maximum depth");
				}
				const timestamp = now(), tagId = id();
				tx.insert(supertags).values({
					id: tagId,
					name: requiredText(input.name, "tag name", 100),
					kind: "user",
					parentId,
					rootId: parent.rootId,
					depth: parent.depth + 1,
					createdAt: timestamp,
					updatedAt: timestamp,
				}).run();
				audit(tx, "supertag", tagId, 1, provenance);
				return tagView(
					tx.select().from(supertags).where(eq(supertags.id, tagId)).get()!,
				);
			}),
		defineField: (
			input: DefineFieldInput,
			provenance: MutationProvenance,
		): FieldDefinition =>
			db.transaction((tx) => {
				const tag = tx.select().from(supertags).where(
					eq(supertags.id, input.tagId),
				).get();
				if (!tag || tag.kind !== "user" || tag.archived) {
					throw new Error("Fields may be added only to active user tags");
				}
				const allowedTypes: FieldType[] = [
					"text",
					"number",
					"boolean",
					"date",
					"datetime",
					"url",
					"email",
					"enum",
					"entityReference",
				];
				if (
					!allowedTypes.includes(input.type) ||
					!["single", "multiple"].includes(input.cardinality)
				) throw new Error("Invalid field definition");
				const options = input.type === "enum"
					? [
						...new Set(
							(input.options ?? []).map((value) =>
								requiredText(value, "enum option", 200)
							),
						),
					]
					: undefined;
				if (input.type === "enum" && !options?.length) {
					throw new Error("Enum fields require options");
				}
				const field: FieldDefinition = {
					id: id(),
					tagId: tag.id,
					key: fieldKey(input.key),
					label: requiredText(input.label, "field label", 100),
					type: input.type,
					cardinality: input.cardinality,
					required: input.required ?? false,
					options,
					defaultValue: undefined,
					archived: false,
				};
				if (input.defaultValue !== undefined) {
					field.defaultValue = validateValue(field, input.defaultValue);
				}
				// Adding an ancestor field must not silently collide in descendants or
				// invalidate entities that already use the affected inheritance branch.
				const inherited = effectiveFields([tag.id]);
				if (
					inherited.some((existing) => existing.key === field.key)
				) throw new Error(`Conflicting field key: ${field.key}`);
				const allTags = tx.select().from(supertags).all();
				const affected = new Set([tag.id]);
				for (let pass = 0; pass < MAX_TAG_DEPTH; pass++) {
					let added = false;
					for (const candidate of allTags) {
						if (
							candidate.parentId && affected.has(candidate.parentId) &&
							!affected.has(candidate.id)
						) {
							affected.add(candidate.id);
							added = true;
						}
					}
					if (!added) break;
				}
				const descendantFields = tx.select().from(fieldDefinitions).where(
					inArray(fieldDefinitions.tagId, [...affected]),
				).all();
				if (
					descendantFields.some((existing) => existing.key === field.key)
				) throw new Error(`Conflicting descendant field key: ${field.key}`);
				const affectedEntities = new Set(
					tx.select().from(entityTags).where(
						inArray(entityTags.tagId, [...affected]),
					).all().map((entry) => entry.entityId),
				);
				if (
					field.required && field.defaultValue === undefined &&
					affectedEntities.size
				) {
					throw new Error(
						"A required field needs a default when entities already use this tag",
					);
				}
				for (const entityId of affectedEntities) {
					const applied = tx.select().from(entityTags).where(
						eq(entityTags.entityId, entityId),
					).all().map((entry) => entry.tagId);
					if (
						effectiveFields(applied).some((existing) =>
							existing.key === field.key
						)
					) throw new Error(`Field key conflicts on entity ${entityId}`);
				}
				tx.insert(fieldDefinitions).values({
					id: field.id,
					tagId: field.tagId,
					key: field.key,
					label: field.label,
					type: field.type,
					cardinality: field.cardinality,
					required: field.required,
					options: field.options ? json(field.options) : null,
					defaultValue: field.defaultValue === undefined
						? null
						: json(field.defaultValue),
					createdAt: now(),
				}).run();
				tx.update(supertags).set({
					revision: tag.revision + 1,
					updatedAt: now(),
				}).where(eq(supertags.id, tag.id)).run();
				audit(tx, "supertag", tag.id, tag.revision + 1, provenance);
				return field;
			}),
		createEntity: (
			input: CreateEntityInput,
			provenance: MutationProvenance,
		): CanonicalEntity =>
			db.transaction((tx) => {
				const entityId = createEntityRows(tx, input, provenance);
				return getEntity(entityId)!;
			}),
		getEntity,
		setUserValues: (
			requestedId: string,
			input: Readonly<Record<string, unknown>>,
			clear: readonly string[],
			provenance: MutationProvenance,
		): CanonicalEntity =>
			db.transaction((tx) => {
				const entityId = resolveId(requestedId),
					current = tx.select().from(entities).where(eq(entities.id, entityId))
						.get();
				if (!current) throw new Error("Entity not found");
				const tagIds = tx.select({ tagId: entityTags.tagId }).from(entityTags)
					.where(eq(entityTags.entityId, entityId)).all().map((entry) =>
						entry.tagId
					);
				const fields = effectiveFields(tagIds),
					values = checkedValues(fields, input),
					valid = new Set(fields.map((field) => field.id));
				if (clear.some((fieldId) => !valid.has(fieldId))) {
					throw new Error("Cannot clear an undefined field");
				}
				for (const fieldId of clear) {
					tx.delete(entityUserValues).where(
						and(
							eq(entityUserValues.entityId, entityId),
							eq(entityUserValues.fieldId, fieldId),
						),
					).run();
				}
				for (const [fieldId, value] of Object.entries(values)) {
					tx.insert(entityUserValues).values({
						entityId,
						fieldId,
						value: json(value),
					}).onConflictDoUpdate({
						target: [entityUserValues.entityId, entityUserValues.fieldId],
						set: { value: json(value) },
					}).run();
				}
				const revision = current.revision + 1;
				tx.update(entities).set({ revision, updatedAt: now() }).where(
					eq(entities.id, entityId),
				).run();
				audit(tx, "entity", entityId, revision, provenance);
				return getEntity(entityId)!;
			}),
		setPreferredSource: (
			requestedId: string,
			fieldId: string,
			source: EntitySource | null,
			provenance: MutationProvenance,
		): CanonicalEntity =>
			db.transaction((tx) => {
				const entityId = resolveId(requestedId),
					current = tx.select().from(entities).where(eq(entities.id, entityId))
						.get();
				if (!current) throw new Error("Entity not found");
				tx.delete(fieldSourcePreferences).where(
					and(
						eq(fieldSourcePreferences.entityId, entityId),
						eq(fieldSourcePreferences.fieldId, fieldId),
					),
				).run();
				if (source) {
					const observation = tx.select().from(sourceObservations).where(
						and(
							eq(sourceObservations.provider, source.provider),
							eq(sourceObservations.connectionId, source.connectionId),
							eq(sourceObservations.resourceType, source.resourceType),
							eq(sourceObservations.resourceId, source.resourceId),
							eq(sourceObservations.entityId, entityId),
							eq(sourceObservations.active, true),
						),
					).get();
					if (
						!observation ||
						!(fieldId in parseJSON<Record<string, unknown>>(observation.values))
					) throw new Error("Preferred source does not provide this field");
					tx.insert(fieldSourcePreferences).values({
						entityId,
						fieldId,
						...source,
					}).run();
				}
				const revision = current.revision + 1;
				tx.update(entities).set({ revision, updatedAt: now() }).where(
					eq(entities.id, entityId),
				).run();
				audit(tx, "entity", entityId, revision, provenance);
				return getEntity(entityId)!;
			}),
		mergeEntities: (
			fromId: string,
			intoId: string,
			provenance: MutationProvenance,
		): CanonicalEntity =>
			db.transaction((tx) => {
				const from = resolveId(fromId), into = resolveId(intoId);
				if (from === into) return getEntity(into)!;
				const fromRow = tx.select().from(entities).where(eq(entities.id, from))
						.get(),
					intoRow = tx.select().from(entities).where(eq(entities.id, into))
						.get();
				if (!fromRow || !intoRow) throw new Error("Entity not found");
				const combinedTags = [
					...new Set(
						tx.select().from(entityTags).where(
							inArray(entityTags.entityId, [from, into]),
						).all().map((row) => row.tagId),
					),
				];
				effectiveFields(combinedTags);
				for (const tagId of combinedTags) {
					tx.insert(entityTags).values({ entityId: into, tagId })
						.onConflictDoNothing().run();
				}
				for (
					const value of tx.select().from(entityUserValues).where(
						eq(entityUserValues.entityId, from),
					).all()
				) {
					tx.insert(entityUserValues).values({
						entityId: into,
						fieldId: value.fieldId,
						value: value.value,
					}).onConflictDoNothing().run();
				}
				for (
					const alias of tx.select().from(entityAliases).where(
						eq(entityAliases.entityId, from),
					).all()
				) {
					tx.insert(entityAliases).values({
						entityId: into,
						alias: alias.alias,
						normalized: alias.normalized,
					}).onConflictDoNothing().run();
				}
				tx.update(sourceObservations).set({ entityId: into }).where(
					eq(sourceObservations.entityId, from),
				).run();
				tx.delete(fieldSourcePreferences).where(
					eq(fieldSourcePreferences.entityId, from),
				).run();
				tx.insert(entityRedirects).values({
					fromEntityId: from,
					toEntityId: into,
					createdAt: now(),
				}).run();
				tx.update(entityRedirects).set({ toEntityId: into }).where(
					eq(entityRedirects.toEntityId, from),
				).run();
				tx.update(entities).set({
					archived: true,
					revision: fromRow.revision + 1,
					updatedAt: now(),
				}).where(eq(entities.id, from)).run();
				const revision = intoRow.revision + 1;
				tx.update(entities).set({ revision, updatedAt: now() }).where(
					eq(entities.id, into),
				).run();
				audit(tx, "entity", from, fromRow.revision + 1, provenance);
				audit(tx, "entity", into, revision, provenance);
				return getEntity(from)!;
			}),
		upsertProjectionBatch: (batch: ProjectionBatch): { changed: number } =>
			db.transaction((tx) => {
				const provider = requiredText(batch.provider, "provider", 100),
					connectionId = requiredText(batch.connectionId, "connection ID", 500),
					provenance = validateProvenance(batch.provenance);
				if (!batch.records.length || batch.records.length > 100) {
					throw new Error("Projection batches contain 1 to 100 records");
				}
				let changed = 0;
				for (const record of batch.records) {
					const resourceType = requiredText(
							record.resourceType,
							"resource type",
							100,
						),
						resourceId = requiredText(record.resourceId, "resource ID", 2_000),
						sourceRevision = requiredText(
							record.sourceRevision,
							"source revision",
							500,
						);
					const tag = tx.select().from(supertags).where(
						eq(supertags.id, record.tagId),
					).get();
					if (!tag || tag.kind !== "integration") {
						throw new Error("Projection requires a locked integration tag");
					}
					const current = tx.select().from(sourceObservations).where(
						and(
							eq(sourceObservations.provider, provider),
							eq(sourceObservations.connectionId, connectionId),
							eq(sourceObservations.resourceType, resourceType),
							eq(sourceObservations.resourceId, resourceId),
						),
					).get();
					if (
						current?.sourceRevision === sourceRevision &&
						current.active === !record.deleted
					) continue;
					if (record.deleted && !current) continue;
					let entityId = current?.entityId;
					if (!entityId) {
						if (record.deleted) continue;
						const fields = effectiveFields([record.tagId]);
						const label = requiredText(record.label, "entity label");
						const values = withPrimaryLabel(
							fields,
							checkedValues(fields, record.values ?? {}),
							label,
						);
						for (const field of fields) {
							if (field.required && !(field.id in values)) {
								throw new Error(`Missing required field: ${field.key}`);
							}
						}
						entityId = id();
						const timestamp = now();
						tx.insert(entities).values({
							id: entityId,
							label,
							normalizedLabel: normalize(label),
							bodyDocumentId: `entity:${entityId}`,
							createdAt: timestamp,
							updatedAt: timestamp,
						}).run();
						tx.insert(entityTags).values({ entityId, tagId: record.tagId })
							.run();
					} else {
						entityId = resolveId(entityId);
						const existingTags = tx.select().from(entityTags).where(
							eq(entityTags.entityId, entityId),
						).all().map((row) => row.tagId);
						effectiveFields([...new Set([...existingTags, record.tagId])]);
						tx.insert(entityTags).values({ entityId, tagId: record.tagId })
							.onConflictDoNothing().run();
					}
					const fields = effectiveFields(
						tx.select().from(entityTags).where(
							eq(entityTags.entityId, entityId),
						).all().map((row) => row.tagId),
					);
					const label = record.deleted && current && !record.label
							? current.label
							: requiredText(record.label, "entity label"),
						values = withPrimaryLabel(
							fields,
							checkedValues(
								fields,
								record.deleted && current && record.values === undefined
									? parseJSON<Record<string, unknown>>(current.values)
									: record.values ?? {},
							),
							label,
						),
						timestamp = now();
					tx.insert(sourceObservations).values({
						provider,
						connectionId,
						resourceType,
						resourceId,
						entityId,
						tagId: record.tagId,
						sourceRevision,
						label,
						values: json(values),
						active: !record.deleted,
						createdAt: current?.createdAt ?? timestamp,
						updatedAt: timestamp,
					}).onConflictDoUpdate({
						target: [
							sourceObservations.provider,
							sourceObservations.connectionId,
							sourceObservations.resourceType,
							sourceObservations.resourceId,
						],
						set: {
							entityId,
							tagId: record.tagId,
							sourceRevision,
							label,
							values: json(values),
							active: !record.deleted,
							updatedAt: timestamp,
						},
					}).run();
					tx.delete(sourceAliases).where(
						and(
							eq(sourceAliases.provider, provider),
							eq(sourceAliases.connectionId, connectionId),
							eq(sourceAliases.resourceType, resourceType),
							eq(sourceAliases.resourceId, resourceId),
						),
					).run();
					for (const alias of record.aliases ?? []) {
						const clean = requiredText(alias, "alias");
						tx.insert(sourceAliases).values({
							provider,
							connectionId,
							resourceType,
							resourceId,
							alias: clean,
							normalized: normalize(clean),
						}).onConflictDoNothing().run();
					}
					const entity = tx.select().from(entities).where(
							eq(entities.id, entityId),
						).get()!,
						revision = entity.revision + (current ? 1 : 0);
					tx.update(entities).set({
						label,
						normalizedLabel: normalize(label),
						revision,
						updatedAt: timestamp,
					})
						.where(eq(entities.id, entityId)).run();
					audit(tx, "entity", entityId, revision, provenance);
					changed++;
				}
				return { changed };
			}),
	};
};
