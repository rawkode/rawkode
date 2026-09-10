export const BASE_TAGS = {
	person: "base:person",
	event: "base:event",
	company: "base:company",
	task: "base:task",
	project: "base:project",
	document: "base:document",
	place: "base:place",
	topic: "base:topic",
	conversation: "base:conversation",
	asset: "base:asset",
} as const;

export const INTEGRATION_TAGS = {
	googleContact: "integration:google:contact",
	googleEvent: "integration:google:event",
	githubUser: "integration:github:user",
	githubOrganization: "integration:github:organization",
	githubRepository: "integration:github:repository",
	githubIssue: "integration:github:issue",
	githubPullRequest: "integration:github:pull-request",
	githubDiscussion: "integration:github:discussion",
} as const;

export const MAX_TAG_DEPTH = 32;

export type BaseTagId = typeof BASE_TAGS[keyof typeof BASE_TAGS];
export type IntegrationTagId =
	typeof INTEGRATION_TAGS[keyof typeof INTEGRATION_TAGS];
export type TagKind = "base" | "integration" | "user";
export type FieldType =
	| "text"
	| "number"
	| "boolean"
	| "date"
	| "datetime"
	| "url"
	| "email"
	| "enum"
	| "entityReference";
export type Cardinality = "single" | "multiple";
export type FieldValue =
	| string
	| number
	| boolean
	| readonly string[]
	| readonly number[]
	| readonly boolean[];

export interface MutationProvenance {
	actor: string;
	cause: string;
	rationale: string;
}

export interface Supertag {
	id: string;
	name: string;
	kind: TagKind;
	parentId: string | null;
	rootId: BaseTagId;
	depth: number;
	revision: number;
	archived: boolean;
}

export interface FieldDefinition {
	id: string;
	tagId: string;
	key: string;
	label: string;
	type: FieldType;
	cardinality: Cardinality;
	required: boolean;
	options?: readonly string[];
	defaultValue?: FieldValue;
	archived: boolean;
}

export interface EffectiveFieldDefinition extends FieldDefinition {
	originTagId: string;
	inherited: boolean;
}

export interface SupertagDetails {
	tag: Supertag;
	fields: readonly EffectiveFieldDefinition[];
	directEntityCount: number;
	inheritedEntityCount: number;
	activeChildTagCount: number;
}

export interface ArchiveImpact {
	allowed: boolean;
	entityCount: number;
	descendantTagCount: number;
	valueCount: number;
}

export interface EntitySource {
	provider: string;
	connectionId: string;
	resourceType: string;
	resourceId: string;
}

export interface CanonicalEntity {
	id: string;
	label: string;
	bodyDocumentId: string;
	bodyDocumentIds: readonly string[];
	mergedEntityIds: readonly string[];
	tagIds: readonly string[];
	values: Readonly<Record<string, FieldValue>>;
	aliases: readonly string[];
	archived: boolean;
	revision: number;
	redirectedTo?: string;
}

export interface EntityRevisionConflict {
	entityId: string;
	expectedRevision: number;
	actualRevision: number;
}

export type EntityMutationResult =
	| { ok: true; entity: CanonicalEntity; conflicts: readonly [] }
	| {
		ok: false;
		entity: CanonicalEntity;
		conflicts: readonly EntityRevisionConflict[];
	};

export interface EntitySummary {
	id: string;
	label: string;
	bodyDocumentId: string;
	tagIds: readonly string[];
	rootId: BaseTagId;
}

export interface EntitySearchOptions {
	rootId?: BaseTagId;
	limit?: number;
}

export interface CreateUserTagInput {
	name: string;
	parentId: string;
}

export interface DefineFieldInput {
	tagId: string;
	key: string;
	label: string;
	type: FieldType;
	cardinality: Cardinality;
	required?: boolean;
	options?: readonly string[];
	defaultValue?: FieldValue;
}

export interface CreateEntityInput {
	label: string;
	tagIds: readonly string[];
	values?: Readonly<Record<string, unknown>>;
	aliases?: readonly string[];
}

export interface ProjectionRecord {
	resourceType: string;
	resourceId: string;
	sourceRevision: string;
	tagId: IntegrationTagId;
	/** May be omitted for a deletion tombstone that already has an observation. */
	label?: string;
	aliases?: readonly string[];
	values?: Readonly<Record<string, unknown>>;
	deleted?: boolean;
}

export interface ProjectionBatch {
	provider: string;
	connectionId: string;
	records: readonly ProjectionRecord[];
	provenance: MutationProvenance;
}

export interface EntitiesApi {
	listTags(): Promise<Supertag[]>;
	getTag(id: string): Promise<SupertagDetails | null>;
	getTagArchiveImpact(id: string): Promise<ArchiveImpact>;
	getFieldArchiveImpact(id: string): Promise<ArchiveImpact>;
	searchEntities(
		query: string,
		options?: EntitySearchOptions,
	): Promise<EntitySummary[]>;
	createUserTag(
		input: CreateUserTagInput,
		provenance: MutationProvenance,
	): Promise<Supertag>;
	renameUserTag(
		id: string,
		name: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	): Promise<SupertagDetails>;
	archiveUserTag(
		id: string,
		expectedRevision: number,
		provenance: MutationProvenance,
	): Promise<SupertagDetails>;
	defineField(
		input: DefineFieldInput,
		provenance: MutationProvenance,
	): Promise<FieldDefinition>;
	archiveField(
		id: string,
		expectedTagRevision: number,
		expectedValueCount: number,
		provenance: MutationProvenance,
	): Promise<SupertagDetails>;
	createEntity(
		input: CreateEntityInput,
		provenance: MutationProvenance,
	): Promise<CanonicalEntity>;
	getEntity(id: string): Promise<CanonicalEntity | null>;
	getEntitySources(id: string): Promise<readonly EntitySource[]>;
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		expectedRevision: number,
		provenance: MutationProvenance,
	): Promise<EntityMutationResult>;
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		expectedRevision: number,
		provenance: MutationProvenance,
	): Promise<EntityMutationResult>;
	mergeEntities(
		fromId: string,
		intoId: string,
		expectedFromRevision: number,
		expectedIntoRevision: number,
		provenance: MutationProvenance,
	): Promise<EntityMutationResult>;
	upsertProjectionBatch(batch: ProjectionBatch): Promise<{ changed: number }>;
}
