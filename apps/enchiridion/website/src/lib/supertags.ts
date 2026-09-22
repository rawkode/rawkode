export type SupertagKind = "base" | "integration" | "user";
export type EntityFieldType =
	| "TEXT"
	| "NUMBER"
	| "BOOLEAN"
	| "DATE"
	| "DATETIME"
	| "URL"
	| "EMAIL"
	| "ENUM"
	| "ENTITY_REFERENCE";
export type EntityFieldCardinality = "SINGLE" | "MULTIPLE";

export interface Supertag {
	id: string;
	name: string;
	kind: SupertagKind;
	parentId: string | null;
	rootId: string;
	depth: number;
	revision: number;
	archived: boolean;
}

export interface EntityValue {
	fieldId: string;
	text: string | null;
	number: number | null;
	boolean: boolean | null;
	strings: string[] | null;
	numbers: number[] | null;
	booleans: boolean[] | null;
}

export interface EntityFieldDefinition {
	id: string;
	tagId: string;
	key: string;
	label: string;
	type: string;
	cardinality: string;
	required: boolean;
	options: string[] | null;
	defaultValue: EntityValue | null;
	archived: boolean;
	originTagId: string;
	inherited: boolean;
}

export interface SupertagDetails {
	tag: Supertag;
	fields: EntityFieldDefinition[];
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

export interface DefineFieldInput {
	tagId: string;
	key: string;
	label: string;
	type: EntityFieldType;
	cardinality: EntityFieldCardinality;
	required: boolean;
	options?: string[];
	defaultValue?: Omit<EntityValue, "fieldId">;
}

type Fetcher = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const detailsSelection = `
	tag { id name kind parentId rootId depth revision archived }
	fields { id tagId key label type cardinality required options archived originTagId inherited
		defaultValue { fieldId text number boolean strings numbers booleans }
	}
	directEntityCount inheritedEntityCount activeChildTagCount
`;

const errorMessage = (
	errors: unknown[] | undefined,
	fallback: string,
): string => {
	const first = errors?.[0];
	if (
		first && typeof first === "object" && "message" in first &&
		typeof first.message === "string" && first.message.trim()
	) return first.message;
	return fallback;
};

export const createSupertagClient = (fetcher: Fetcher = fetch) => {
	const request = async <T>(
		query: string,
		variables: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<T> => {
		const response = await fetcher("/api/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal,
		});
		if (!response.ok) throw new Error("Supertags are unavailable.");
		const result = await response.json() as { data?: T; errors?: unknown[] };
		if (!result.data || result.errors?.length) {
			throw new Error(
				errorMessage(result.errors, "Supertags are unavailable."),
			);
		}
		return result.data;
	};

	return {
		list: async (signal?: AbortSignal): Promise<Supertag[]> => {
			const data = await request<{ me: { supertags: Supertag[] } }>(
				`query ManageSupertags { me { supertags { id name kind parentId rootId depth revision archived } } }`,
				{},
				signal,
			);
			return data.me.supertags;
		},
		details: async (
			id: string,
			signal?: AbortSignal,
		): Promise<SupertagDetails | null> => {
			const data = await request<{ me: { supertag: SupertagDetails | null } }>(
				`query ManageSupertag($id: ID!) { me { supertag(id: $id) { ${detailsSelection} } } }`,
				{ id },
				signal,
			);
			return data.me.supertag;
		},
		create: async (name: string, parentId: string): Promise<Supertag> => {
			const data = await request<{ createUserTag: Supertag }>(
				`mutation CreateManagedSupertag($name: String!, $parentId: ID!) {
					createUserTag(input: { name: $name, parentId: $parentId }) {
						id name kind parentId rootId depth revision archived
					}
				}`,
				{ name, parentId },
			);
			return data.createUserTag;
		},
		rename: async (
			id: string,
			name: string,
			expectedRevision: number,
		): Promise<SupertagDetails> => {
			const data = await request<{ renameUserTag: SupertagDetails }>(
				`mutation RenameManagedSupertag($id: ID!, $name: String!, $expectedRevision: Int!) {
					renameUserTag(input: { id: $id, name: $name, expectedRevision: $expectedRevision }) { ${detailsSelection} }
				}`,
				{ id, name, expectedRevision },
			);
			return data.renameUserTag;
		},
		tagArchiveImpact: async (id: string): Promise<ArchiveImpact> => {
			const data = await request<
				{ me: { supertagArchiveImpact: ArchiveImpact } }
			>(
				`query ManagedSupertagArchiveImpact($id: ID!) {
					me { supertagArchiveImpact(id: $id) { allowed entityCount descendantTagCount valueCount } }
				}`,
				{ id },
			);
			return data.me.supertagArchiveImpact;
		},
		archiveTag: async (
			id: string,
			expectedRevision: number,
		): Promise<SupertagDetails> => {
			const data = await request<{ archiveUserTag: SupertagDetails }>(
				`mutation ArchiveManagedSupertag($id: ID!, $expectedRevision: Int!) {
					archiveUserTag(input: { id: $id, expectedRevision: $expectedRevision }) { ${detailsSelection} }
				}`,
				{ id, expectedRevision },
			);
			return data.archiveUserTag;
		},
		defineField: async (
			input: DefineFieldInput,
		): Promise<EntityFieldDefinition> => {
			const data = await request<{ defineEntityField: EntityFieldDefinition }>(
				`mutation DefineManagedEntityField($input: DefineEntityFieldInput!) {
					defineEntityField(input: $input) {
						id tagId key label type cardinality required options archived originTagId inherited
						defaultValue { fieldId text number boolean strings numbers booleans }
					}
				}`,
				{ input },
			);
			return data.defineEntityField;
		},
		fieldArchiveImpact: async (id: string): Promise<ArchiveImpact> => {
			const data = await request<{
				me: { entityFieldArchiveImpact: ArchiveImpact };
			}>(
				`query ManagedFieldArchiveImpact($id: ID!) {
					me { entityFieldArchiveImpact(id: $id) { allowed entityCount descendantTagCount valueCount } }
				}`,
				{ id },
			);
			return data.me.entityFieldArchiveImpact;
		},
		archiveField: async (
			id: string,
			expectedTagRevision: number,
			expectedValueCount: number,
		): Promise<SupertagDetails> => {
			const data = await request<{ archiveEntityField: SupertagDetails }>(
				`mutation ArchiveManagedEntityField($id: ID!, $expectedTagRevision: Int!, $expectedValueCount: Int!) {
					archiveEntityField(input: { id: $id, expectedTagRevision: $expectedTagRevision, expectedValueCount: $expectedValueCount }) { ${detailsSelection} }
				}`,
				{ id, expectedTagRevision, expectedValueCount },
			);
			return data.archiveEntityField;
		},
	};
};

export interface FieldDraft {
	key: string;
	label: string;
	type: EntityFieldType;
	cardinality: EntityFieldCardinality;
	required: boolean;
	options: string;
	defaultValue: string;
	hasDefault: boolean;
}

const separated = (
	value: string,
): string[] => [
	...new Set(value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean)),
];

export const defineFieldInput = (
	tagId: string,
	draft: FieldDraft,
): DefineFieldInput => {
	const key = draft.key.trim();
	const label = draft.label.trim();
	if (!key || !label) throw new Error("Enter a field key and label.");
	const options = draft.type === "ENUM" ? separated(draft.options) : undefined;
	if (draft.type === "ENUM" && !options?.length) {
		throw new Error("Add at least one enum option.");
	}
	const input: DefineFieldInput = {
		tagId,
		key,
		label,
		type: draft.type,
		cardinality: draft.cardinality,
		required: draft.required,
		...(options ? { options } : {}),
	};
	if (!draft.hasDefault) return input;
	const values = separated(draft.defaultValue);
	if (!values.length) {
		throw new Error("Enter a default value or turn off the default.");
	}
	if (draft.cardinality === "MULTIPLE") {
		if (draft.type === "NUMBER") {
			const numbers = values.map(Number);
			if (numbers.some((value) => !Number.isFinite(value))) {
				throw new Error("Every default must be a number.");
			}
			input.defaultValue = {
				text: null,
				number: null,
				boolean: null,
				strings: null,
				numbers,
				booleans: null,
			};
		} else if (draft.type === "BOOLEAN") {
			const normalized = values.map((value) => value.toLowerCase());
			if (normalized.some((value) => value !== "true" && value !== "false")) {
				throw new Error("Boolean defaults must be true or false.");
			}
			input.defaultValue = {
				text: null,
				number: null,
				boolean: null,
				strings: null,
				numbers: null,
				booleans: normalized.map((value) => value === "true"),
			};
		} else {
			input.defaultValue = {
				text: null,
				number: null,
				boolean: null,
				strings: values,
				numbers: null,
				booleans: null,
			};
		}
		return input;
	}
	const value = draft.defaultValue.trim();
	if (draft.type === "NUMBER") {
		const number = Number(value);
		if (!Number.isFinite(number)) {
			throw new Error("The default must be a number.");
		}
		input.defaultValue = {
			text: null,
			number,
			boolean: null,
			strings: null,
			numbers: null,
			booleans: null,
		};
	} else if (draft.type === "BOOLEAN") {
		if (!["true", "false"].includes(value.toLowerCase())) {
			throw new Error("The boolean default must be true or false.");
		}
		input.defaultValue = {
			text: null,
			number: null,
			boolean: value.toLowerCase() === "true",
			strings: null,
			numbers: null,
			booleans: null,
		};
	} else {
		input.defaultValue = {
			text: value,
			number: null,
			boolean: null,
			strings: null,
			numbers: null,
			booleans: null,
		};
	}
	return input;
};
