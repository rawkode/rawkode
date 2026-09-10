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
	tagIds: readonly string[];
	values: Readonly<Record<string, FieldValue>>;
	aliases: readonly string[];
	archived: boolean;
	revision: number;
	redirectedTo?: string;
}

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
	searchEntities(
		query: string,
		options?: EntitySearchOptions,
	): Promise<EntitySummary[]>;
	createUserTag(
		input: CreateUserTagInput,
		provenance: MutationProvenance,
	): Promise<Supertag>;
	defineField(
		input: DefineFieldInput,
		provenance: MutationProvenance,
	): Promise<FieldDefinition>;
	createEntity(
		input: CreateEntityInput,
		provenance: MutationProvenance,
	): Promise<CanonicalEntity>;
	getEntity(id: string): Promise<CanonicalEntity | null>;
	setUserValues(
		id: string,
		values: Readonly<Record<string, unknown>>,
		clear: readonly string[],
		provenance: MutationProvenance,
	): Promise<CanonicalEntity>;
	setPreferredSource(
		id: string,
		fieldId: string,
		source: EntitySource | null,
		provenance: MutationProvenance,
	): Promise<CanonicalEntity>;
	mergeEntities(
		fromId: string,
		intoId: string,
		provenance: MutationProvenance,
	): Promise<CanonicalEntity>;
	upsertProjectionBatch(batch: ProjectionBatch): Promise<{ changed: number }>;
}
