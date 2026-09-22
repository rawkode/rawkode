export type EntityProvider = "google" | "github";

export type EntityKind =
	| "person"
	| "event"
	| "issue"
	| "pullRequest"
	| "discussion";

export interface EntityReference {
	provider: EntityProvider;
	kind: EntityKind;
	id: string;
	label: string;
	avatarURL?: string;
	meta?: string;
}

export interface EditorCommandDefinition {
	id: string;
	label: string;
	detail: string;
	keywords: readonly string[];
}

export interface EditorEntityDefinition {
	id: string;
	label: string;
	trigger: "@";
	kind: EntityKind;
	provider: EntityProvider;
}

export interface EditorIntegrationManifest {
	id: string;
	commands: readonly EditorCommandDefinition[];
	entities: readonly EditorEntityDefinition[];
}
