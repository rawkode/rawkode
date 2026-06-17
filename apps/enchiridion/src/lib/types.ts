export type JsonObject = Record<string, unknown>;

export interface CloudflareAIBinding {
	run(modelId: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<Response | Record<string, unknown>>;
}

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	AI?: CloudflareAIBinding;
	MINI_APP_DISPATCHER?: {
		get(scriptName: string): Fetcher;
	};
	DEV_USER_EMAIL?: string;
	ALLOWED_EMAILS?: string;
	ENCHIRIDION_PASSWORD?: string;
	HOST_SIGNING_SECRET?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_DISPATCH_NAMESPACE?: string;
}

export interface Principal {
	email: string;
	name: string;
	source: "cloudflare-access" | "password" | "dev";
}

export interface DailyNote {
	id: string;
	date: string;
	title: string;
	documentJson: JsonObject;
	textContent: string;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface ResourceIndexRecord {
	id: string;
	sourceApp: string;
	sourceType: string;
	sourceId: string;
	title: string;
	summary: string;
	url: string | null;
	tags: string[];
	relationships: JsonObject[];
	occurredAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Bookmark {
	id: string;
	title: string;
	url: string;
	description: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
}

export interface Project {
	id: string;
	name: string;
	description: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export interface KanbanBoard {
	id: string;
	projectId: string | null;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface KanbanColumn {
	id: string;
	boardId: string;
	name: string;
	position: number;
	createdAt: string;
	updatedAt: string;
}

export interface KanbanCard {
	id: string;
	boardId: string;
	columnId: string;
	title: string;
	description: string;
	position: number;
	createdAt: string;
	updatedAt: string;
}

export interface AppSnapshot {
	dailyNote: DailyNote;
	recentNotes: DailyNote[];
	extensions: ExtensionManifest[];
	commands: ExtensionCommand[];
	editorBlocks: ExtensionEditorBlock[];
	scheduledWorkflows: ScheduledWorkflow[];
	bookmarks: Bookmark[];
	projects: Project[];
	boards: Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>;
	resourceIndex: ResourceIndexRecord[];
	principal: Principal;
}

export interface ScheduledWorkflow {
	id: string;
	extensionSlug: string | null;
	name: string;
	cron: string;
	workflowName: string;
	payload: JsonObject;
	enabled: boolean;
	lastRunAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type ExtensionRouteMode = "worker-page" | "worker-fragment" | "host-primitive" | "native-promoted";

export interface ExtensionRoute {
	path: string;
	mode: ExtensionRouteMode;
	label: string;
	description?: string;
}

export interface ExtensionCommand {
	id: string;
	label: string;
	description: string;
	kind: "navigate" | "create" | "workflow" | "insert-block";
	scope: "global" | "daily-note" | "selection" | "app";
	app: string;
	action: string;
	inputSchema?: JsonObject;
	requiredHostApis: string[];
}

export interface ExtensionEditorBlock {
	id: string;
	app: string;
	label: string;
	description: string;
	defaultProps: JsonObject;
	renderer: "host-primitive" | "worker-fragment" | "native-promoted";
	requiredHostApis: string[];
}

export interface ExtensionWorkflow {
	id: string;
	label: string;
	trigger: "manual" | "scheduled" | "webhook";
	workflowName: string;
	cron?: string;
	inputSchema?: JsonObject;
	requiredHostApis: string[];
}

export interface ExtensionBinding {
	type: "kv_namespace" | "d1_database" | "r2_bucket";
	name: string;
	purpose: string;
}

export interface ExtensionIndexProjection {
	sourceType: string;
	titlePath: string;
	summaryPath?: string;
	urlPath?: string;
	tagsPath?: string;
}

export interface ExtensionManifest {
	slug: string;
	name: string;
	version: string;
	description: string;
	status?: "dynamic" | "promoted" | "disabled" | "builtin";
	routes: ExtensionRoute[];
	commands: ExtensionCommand[];
	editorBlocks: ExtensionEditorBlock[];
	workflows: ExtensionWorkflow[];
	bindings: ExtensionBinding[];
	hostApis: string[];
	indexProjections: ExtensionIndexProjection[];
}
