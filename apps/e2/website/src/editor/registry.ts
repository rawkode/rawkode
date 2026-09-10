import type {
	EditorCommandDefinition,
	EditorEntityDefinition,
	EditorIntegrationManifest,
} from "@e2/editor/contracts";
import type { EntityReference } from "@e2/documents/note";
import { githubEditor } from "../../../integrations/github/editor.ts";
import { googleEditor } from "../../../integrations/google/editor.ts";

export interface EditorCommandContext {
	notify: (message: string) => void;
}

export interface RegisteredCommand extends EditorCommandDefinition {
	run: (context: EditorCommandContext) => void | Promise<void>;
}

export interface RegisteredEntity extends EditorEntityDefinition {
	search: (query: string) => Promise<EntityReference[]>;
}

export interface EditorRegistry {
	commands: readonly RegisteredCommand[];
	entities: readonly RegisteredEntity[];
}

const request = async <T>(
	query: string,
	variables: Record<string, unknown>,
) => {
	const response = await fetch("/api/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) throw new Error("Entity search is unavailable.");
	const result = await response.json() as { data?: T; errors?: unknown[] };
	if (result.errors?.length || !result.data) {
		throw new Error("Entity search is unavailable.");
	}
	return result.data;
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

const googlePeople = async (query: string): Promise<EntityReference[]> => {
	const data = await request<{
		me: {
			googlePeople: {
				id: string;
				connectionId: string;
				displayName: string;
				emails: string[];
			}[];
		};
	}>(
		`query EditorPeople($query: String!) {
      me { googlePeople(query: $query) { id connectionId displayName emails } }
    }`,
		{ query },
	);
	return data.me.googlePeople.map((person) => ({
		provider: "google",
		kind: "person",
		id: boundedEntityId(person.connectionId, person.id),
		label: person.displayName || person.emails[0] || "Unnamed contact",
		meta: person.emails[0],
	}));
};

const googleEvents = async (query: string): Promise<EntityReference[]> => {
	const data = await request<{
		me: {
			googleEvents: {
				id: string;
				connectionId: string;
				calendarId: string | null;
				summary: string;
				start: string | null;
			}[];
		};
	}>(
		`query EditorEvents($query: String!) {
			me { googleEvents(query: $query) { id connectionId calendarId summary start } }
    }`,
		{ query },
	);
	return data.me.googleEvents.map((event) => ({
		provider: "google",
		kind: "event",
		id: boundedEntityId(
			event.connectionId,
			event.calendarId ?? "unknown",
			event.id,
		),
		label: event.summary || "Untitled event",
		meta: event.start ?? undefined,
	}));
};

const entityKinds = new Set<EntityReference["kind"]>([
	"person",
	"event",
	"issue",
	"pullRequest",
	"discussion",
]);
const githubActivityRows = async (
	query: string,
): Promise<EntityReference[]> => {
	const data = await request<{
		me: {
			githubActivity: {
				id: string;
				connectionId: string;
				resourceId: string;
				kind: string;
				title: string;
				url: string;
			}[];
		};
	}>(
		`query EditorGitHub($query: String!) {
      me { githubActivity(query: $query) { id connectionId resourceId kind title url } }
    }`,
		{ query },
	);
	return data.me.githubActivity.flatMap((item) => {
		if (!entityKinds.has(item.kind as EntityReference["kind"])) return [];
		const itemKind = item.kind as EntityReference["kind"];
		return [{
			provider: "github" as const,
			kind: itemKind,
			id: boundedEntityId(item.connectionId, item.resourceId),
			label: item.title,
			meta: item.url,
		}];
	});
};
const githubActivityCache = new Map<string, Promise<EntityReference[]>>();
const githubActivity = async (
	query: string,
	kind?: EntityReference["kind"],
): Promise<EntityReference[]> => {
	let pending = githubActivityCache.get(query);
	if (!pending) {
		pending = githubActivityRows(query);
		githubActivityCache.set(query, pending);
		pending.then(
			() => {
				if (githubActivityCache.get(query) === pending) {
					githubActivityCache.delete(query);
				}
			},
			() => {
				if (githubActivityCache.get(query) === pending) {
					githubActivityCache.delete(query);
				}
			},
		);
	}
	try {
		const rows = await pending;
		return kind ? rows.filter((row) => row.kind === kind) : rows;
	} catch (error) {
		githubActivityCache.delete(query);
		throw error;
	}
};

const emptySearch = (): Promise<EntityReference[]> => Promise.resolve([]);

const entities = (manifest: EditorIntegrationManifest): RegisteredEntity[] =>
	manifest.entities.map((definition) => ({
		...definition,
		search: definition.id === "google.people"
			? googlePeople
			: definition.id === "google.events"
			? googleEvents
			: definition.provider === "github"
			? (query) => githubActivity(query, definition.kind)
			: emptySearch,
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
