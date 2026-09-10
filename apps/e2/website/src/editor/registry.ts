import type {
	EditorCommandDefinition,
	EditorEntityDefinition,
	EditorIntegrationManifest,
} from "@e2/editor/contracts";
import type { CanonicalEntityReference } from "@e2/documents/note";
import { githubEditor } from "../../../integrations/github/editor.ts";
import { googleEditor } from "../../../integrations/google/editor.ts";

export interface EditorCommandContext {
	notify: (message: string) => void;
}

export interface RegisteredCommand extends EditorCommandDefinition {
	run: (context: EditorCommandContext) => void | Promise<void>;
}

export interface RegisteredEntity extends EditorEntityDefinition {
	search: (query: string) => Promise<CanonicalEntityReference[]>;
}

export interface EditorRegistry {
	commands: readonly RegisteredCommand[];
	entities: readonly RegisteredEntity[];
}

const request = async <T>(
	query: string,
	variables: Record<string, unknown>,
	signal?: AbortSignal,
	unavailable = "Entity search is unavailable.",
) => {
	const response = await fetch("/api/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
		signal,
	});
	if (!response.ok) throw new Error(unavailable);
	const result = await response.json() as { data?: T; errors?: unknown[] };
	if (result.errors?.length || !result.data) {
		throw new Error(unavailable);
	}
	return result.data;
};

export interface CanonicalEntitySummary {
	id: string;
	label: string;
	bodyDocumentId: string;
	tagIds: string[];
	rootId: string;
}

export interface CanonicalSupertag {
	id: string;
	name: string;
	kind: "base" | "integration" | "user";
	parentId: string | null;
	rootId: string;
	archived: boolean;
}

export const searchCanonicalEntities = async (
	query: string,
	rootId: string | undefined,
	signal?: AbortSignal,
): Promise<CanonicalEntitySummary[]> => {
	const data = await request<{
		me: { entities: CanonicalEntitySummary[] };
	}>(
		`query EditorEntities($query: String!, $rootId: ID) {
			me { entities(query: $query, rootId: $rootId, limit: 12) {
				id label bodyDocumentId tagIds rootId
			} }
		}`,
		{ query, rootId: rootId ?? null },
		signal,
	);
	return data.me.entities;
};

export const listCanonicalSupertags = async (
	signal?: AbortSignal,
): Promise<CanonicalSupertag[]> => {
	const data = await request<{ me: { supertags: CanonicalSupertag[] } }>(
		`query EditorSupertags {
			me { supertags { id name kind parentId rootId archived } }
		}`,
		{},
		signal,
		"Supertags are unavailable.",
	);
	return data.me.supertags;
};

export const createCanonicalEntity = async (
	label: string,
	tagId: string,
	signal?: AbortSignal,
): Promise<Omit<CanonicalEntitySummary, "rootId">> => {
	const data = await request<{
		createEntity: Omit<CanonicalEntitySummary, "rootId">;
	}>(
		`mutation EditorCreateEntity($label: String!, $tagIds: [ID!]!) {
			createEntity(input: { label: $label, tagIds: $tagIds }) {
				id label bodyDocumentId tagIds
			}
		}`,
		{ label, tagIds: [tagId] },
		signal,
		"The entity could not be created.",
	);
	return data.createEntity;
};

export const boundedEntityId = (...parts: string[]): string => {
	const value = parts.join(":");
	if (value.length <= 480) return value;
	let hash = 14695981039346656037n;
	for (const character of value) {
		hash ^= BigInt(character.codePointAt(0)!);
		hash = BigInt.asUintN(64, hash * 1099511628211n);
	}
	return `${value.slice(0, 460)}:${hash.toString(36)}`;
};

const rootByKind: Record<EditorEntityDefinition["kind"], string> = {
	person: "base:person",
	event: "base:event",
	issue: "base:task",
	pullRequest: "base:task",
	discussion: "base:conversation",
};
const integrationTagByDefinition: Record<string, string> = {
	"google.people": "integration:google:contact",
	"google.events": "integration:google:event",
	"github.issues": "integration:github:issue",
	"github.pull-requests": "integration:github:pull-request",
	"github.discussions": "integration:github:discussion",
};

const canonicalSearch = async (
	definition: EditorEntityDefinition,
	query: string,
): Promise<CanonicalEntityReference[]> =>
	(await searchCanonicalEntities(query, rootByKind[definition.kind])).filter(
		(entity) =>
			entity.tagIds.includes(integrationTagByDefinition[definition.id]!),
	).map(
		(entity) => ({
			version: 1,
			entityId: entity.id,
			fallbackLabel: entity.label,
			displayText: entity.label,
			presentation: "mention",
		}),
	);

const entities = (manifest: EditorIntegrationManifest): RegisteredEntity[] =>
	manifest.entities.map((definition) => ({
		...definition,
		search: (query) => canonicalSearch(definition, query),
	}));

const commands = (manifest: EditorIntegrationManifest): RegisteredCommand[] =>
	manifest.commands.map((definition) => ({
		...definition,
		run: ({ notify }) => notify(`${definition.label} is coming soon.`),
	}));

const manifests = [googleEditor, githubEditor] as const;

export const editorRegistry: EditorRegistry = {
	commands: manifests.flatMap(commands),
	entities: manifests.flatMap(entities),
};
