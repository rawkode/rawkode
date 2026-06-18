import { addDays, isoNow, titleForDailyNote, todayDateKey } from "./dates";
import { miniAppWorkflowRoutePath } from "./mini-app-workflows";
import { builtinExtensionManifests, builtinScheduledWorkflows } from "./seed";
import { emptyTiptapDocument, extractTextFromTiptap, parseJsonArray, parseJsonObject } from "./text";
import type {
	AppSnapshot,
	Bookmark,
	DailyNote,
	Env,
	ExtensionManifest,
	ExtensionBindingRequest,
	ExtensionBindingRequestStatus,
	ExtensionWorkflow,
	JsonObject,
	KanbanBoard,
	KanbanCard,
	KanbanColumn,
	MiniAppAuditRecord,
	MiniAppBuild,
	MiniAppBuildEvent,
	MiniAppBuildStatus,
	Principal,
	Project,
	RegisteredExtension,
	ReferenceTarget,
	ResourceIndexRecord,
	ScheduledWorkflow,
} from "./types";

interface DailyNoteRow {
	id: string;
	date: string;
	title: string;
	document_json: string;
	text_content: string;
	version: number;
	created_at: string;
	updated_at: string;
}

interface ExtensionRow {
	slug: string;
	manifest_json: string;
	status: ExtensionManifest["status"];
	deployed_script_name: string | null;
	created_at: string;
	updated_at: string;
}

interface ResourceRow {
	id: string;
	source_app: string;
	source_type: string;
	source_id: string;
	title: string;
	summary: string;
	url: string | null;
	tags_json: string;
	relationships_json: string;
	occurred_at: string | null;
	created_at: string;
	updated_at: string;
}

interface BookmarkRow {
	id: string;
	title: string;
	url: string;
	description: string;
	tags_json: string;
	created_at: string;
	updated_at: string;
}

interface ProjectRow {
	id: string;
	name: string;
	description: string;
	status: string;
	created_at: string;
	updated_at: string;
}

interface BoardRow {
	id: string;
	project_id: string | null;
	name: string;
	created_at: string;
	updated_at: string;
}

interface ColumnRow {
	id: string;
	board_id: string;
	name: string;
	position: number;
	created_at: string;
	updated_at: string;
}

interface CardRow {
	id: string;
	board_id: string;
	column_id: string;
	title: string;
	description: string;
	position: number;
	created_at: string;
	updated_at: string;
}

interface WorkflowRow {
	id: string;
	extension_slug: string | null;
	name: string;
	cron: string;
	workflow_name: string;
	payload_json: string;
	enabled: number;
	last_run_at: string | null;
	created_at: string;
	updated_at: string;
}

interface MiniAppAuditRow {
	id: string;
	slug: string;
	action: string;
	status: string;
	details_json: string;
	created_at: string;
}

interface MiniAppBuildRow {
	id: string;
	prompt: string;
	operation: "create" | "update";
	target_slug: string | null;
	slug_hint: string | null;
	autonomous_deploy: number;
	status: MiniAppBuildStatus;
	attempt_count: number;
	max_attempts: number;
	current_run_id: string | null;
	result_json: string | null;
	error_json: string | null;
	deadline_at: string;
	completed_at: string | null;
	created_at: string;
	updated_at: string;
}

interface MiniAppBuildEventRow {
	id: string;
	build_id: string;
	sequence: number;
	type: string;
	message: string;
	details_json: string;
	created_at: string;
}

interface ExtensionBindingRequestRow {
	id: string;
	extension_slug: string;
	extension_name: string;
	operation: "create" | "update";
	manifest_json: string;
	worker_source: string;
	deployment_notes: string;
	bindings_json: string;
	resolved_bindings_json: string;
	issues_json: string;
	status: ExtensionBindingRequestStatus;
	created_at: string;
	updated_at: string;
}

export async function ensureBuiltins(env: Env): Promise<void> {
	const now = isoNow();

	for (const manifest of builtinExtensionManifests) {
		await env.DB.prepare(`
			INSERT INTO extension_manifests (slug, manifest_json, status, deployed_script_name, created_at, updated_at)
			VALUES (?, ?, ?, NULL, ?, ?)
			ON CONFLICT(slug) DO UPDATE SET
				manifest_json = excluded.manifest_json,
				status = excluded.status,
				updated_at = excluded.updated_at
		`).bind(manifest.slug, JSON.stringify(manifest), manifest.status ?? "builtin", now, now).run();
	}

	for (const workflow of builtinScheduledWorkflows) {
		await env.DB.prepare(`
			INSERT INTO scheduled_workflows (id, extension_slug, name, cron, workflow_name, payload_json, enabled, last_run_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO NOTHING
		`).bind(
			workflow.id,
			workflow.extensionSlug,
			workflow.name,
			workflow.cron,
			workflow.workflowName,
			JSON.stringify(workflow.payload),
			workflow.enabled ? 1 : 0,
			workflow.lastRunAt,
			workflow.createdAt,
			workflow.updatedAt,
		).run();
	}

	await ensureDemoData(env);
}

export async function getOrCreateDailyNote(env: Env, date = todayDateKey()): Promise<DailyNote> {
	const existing = await getDailyNote(env, date);
	if (existing) {
		return existing;
	}

	const now = isoNow();
	const doc = emptyTiptapDocument();
	const note: DailyNote = {
		id: crypto.randomUUID(),
		date,
		title: titleForDailyNote(date),
		documentJson: doc,
		textContent: "",
		version: 1,
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO daily_notes (id, date, title, document_json, text_content, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		note.id,
		note.date,
		note.title,
		JSON.stringify(note.documentJson),
		note.textContent,
		note.version,
		note.createdAt,
		note.updatedAt,
	).run();

	await upsertResourceIndex(env, {
		id: `note:${note.id}`,
		sourceApp: "notes",
		sourceType: "daily-note",
		sourceId: note.id,
		title: note.title,
		summary: note.textContent,
		url: `/daily/${note.date}`,
		tags: ["daily-note"],
		relationships: [],
		occurredAt: `${note.date}T12:00:00.000Z`,
		createdAt: now,
		updatedAt: now,
	});

	return note;
}

export async function getDailyNote(env: Env, date: string): Promise<DailyNote | null> {
	const row = await env.DB.prepare("SELECT * FROM daily_notes WHERE date = ?").bind(date).first<DailyNoteRow>();
	return row ? mapDailyNote(row) : null;
}

export async function listRecentDailyNotes(env: Env, limit = 14, before?: string): Promise<DailyNote[]> {
	const query = before
		? env.DB.prepare("SELECT * FROM daily_notes WHERE date < ? ORDER BY date DESC LIMIT ?").bind(before, limit)
		: env.DB.prepare("SELECT * FROM daily_notes ORDER BY date DESC LIMIT ?").bind(limit);
	const result = await query.all<DailyNoteRow>();
	return (result.results ?? []).map(mapDailyNote);
}

export async function saveDailyNote(env: Env, date: string, documentJson: JsonObject, expectedVersion?: number): Promise<DailyNote> {
	const note = await getOrCreateDailyNote(env, date);
	if (expectedVersion !== undefined && expectedVersion !== note.version) {
		throw new Response(JSON.stringify({
			error: "Version conflict",
			currentVersion: note.version,
		}), {
			status: 409,
			headers: { "content-type": "application/json" },
		});
	}

	const textContent = extractTextFromTiptap(documentJson);
	const updatedAt = isoNow();
	const version = note.version + 1;

	await env.DB.prepare(`
		UPDATE daily_notes
		SET document_json = ?, text_content = ?, version = ?, updated_at = ?
		WHERE date = ?
	`).bind(JSON.stringify(documentJson), textContent, version, updatedAt, date).run();

	const saved = await getDailyNote(env, date);
	if (!saved) {
		throw new Error("Daily note disappeared after save.");
	}

	await upsertResourceIndex(env, {
		id: `note:${saved.id}`,
		sourceApp: "notes",
		sourceType: "daily-note",
		sourceId: saved.id,
		title: saved.title,
		summary: saved.textContent,
		url: `/daily/${saved.date}`,
		tags: ["daily-note"],
		relationships: [],
		occurredAt: `${saved.date}T12:00:00.000Z`,
		createdAt: saved.createdAt,
		updatedAt: saved.updatedAt,
	});

	return saved;
}

export async function listExtensions(env: Env): Promise<ExtensionManifest[]> {
	const result = await env.DB.prepare("SELECT * FROM extension_manifests ORDER BY slug ASC").all<ExtensionRow>();
	return (result.results ?? []).map(mapExtension);
}

export async function listRegisteredExtensions(env: Env): Promise<RegisteredExtension[]> {
	const result = await env.DB.prepare("SELECT * FROM extension_manifests ORDER BY slug ASC").all<ExtensionRow>();
	return (result.results ?? []).map(mapRegisteredExtension);
}

export async function getExtension(env: Env, slug: string): Promise<RegisteredExtension | null> {
	const row = await env.DB.prepare("SELECT * FROM extension_manifests WHERE slug = ?").bind(slug).first<ExtensionRow>();
	if (!row) {
		return null;
	}
	return mapRegisteredExtension(row);
}

export async function saveExtension(env: Env, manifest: ExtensionManifest, deployedScriptName: string | null, status = "dynamic"): Promise<void> {
	const now = isoNow();
	await env.DB.prepare(`
		INSERT INTO extension_manifests (slug, manifest_json, status, deployed_script_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(slug) DO UPDATE SET
			manifest_json = excluded.manifest_json,
			status = excluded.status,
			deployed_script_name = excluded.deployed_script_name,
			updated_at = excluded.updated_at
	`).bind(manifest.slug, JSON.stringify(manifest), status, deployedScriptName, now, now).run();

	await syncExtensionScheduledWorkflows(env, manifest, now);
}

export function scheduledWorkflowsForExtension(manifest: ExtensionManifest, now = isoNow()): ScheduledWorkflow[] {
	return manifest.workflows
		.filter((workflow) => workflow.trigger === "scheduled" && Boolean(workflow.cron?.trim()))
		.map((workflow) => ({
			id: scheduledWorkflowIdForExtension(manifest.slug, workflow.id),
			extensionSlug: manifest.slug,
			name: `${manifest.name}: ${workflow.label}`,
			cron: workflow.cron?.trim() ?? "",
			workflowName: workflow.workflowName,
			payload: scheduledWorkflowPayloadForExtension(manifest, workflow),
			enabled: false,
			lastRunAt: null,
			createdAt: now,
			updatedAt: now,
		}));
}

function scheduledWorkflowIdForExtension(slug: string, workflowId: string): string {
	return `${slug}:${workflowId}`;
}

function scheduledWorkflowPayloadForExtension(manifest: ExtensionManifest, workflow: ExtensionWorkflow): JsonObject {
	return {
		app: manifest.slug,
		callbackPath: miniAppWorkflowRoutePath(manifest.slug, workflow.id),
		extensionSlug: manifest.slug,
		manifestVersion: manifest.version,
		workflowId: workflow.id,
		workflowName: workflow.workflowName,
		requiredHostApis: workflow.requiredHostApis,
		...(workflow.inputSchema ? { inputSchema: workflow.inputSchema } : {}),
	};
}

async function syncExtensionScheduledWorkflows(env: Env, manifest: ExtensionManifest, now: string): Promise<void> {
	const workflows = scheduledWorkflowsForExtension(manifest, now);
	const desiredIds = new Set(workflows.map((workflow) => workflow.id));
	const existing = await env.DB.prepare("SELECT id FROM scheduled_workflows WHERE extension_slug = ?")
		.bind(manifest.slug)
		.all<{ id: string }>();

	for (const row of existing.results ?? []) {
		if (!desiredIds.has(row.id)) {
			await env.DB.prepare("DELETE FROM scheduled_workflows WHERE extension_slug = ? AND id = ?")
				.bind(manifest.slug, row.id)
				.run();
		}
	}

	for (const workflow of workflows) {
		await env.DB.prepare(`
			INSERT INTO scheduled_workflows (id, extension_slug, name, cron, workflow_name, payload_json, enabled, last_run_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				extension_slug = excluded.extension_slug,
				name = excluded.name,
				cron = excluded.cron,
				workflow_name = excluded.workflow_name,
				payload_json = excluded.payload_json,
				updated_at = excluded.updated_at
		`).bind(
			workflow.id,
			workflow.extensionSlug,
			workflow.name,
			workflow.cron,
			workflow.workflowName,
			JSON.stringify(workflow.payload),
			workflow.enabled ? 1 : 0,
			workflow.lastRunAt,
			workflow.createdAt,
			workflow.updatedAt,
		).run();
	}
}

export async function searchResources(env: Env, query: string, limit = 20): Promise<ResourceIndexRecord[]> {
	const normalized = `%${query.trim()}%`;
	const result = query.trim()
		? await env.DB.prepare(`
			SELECT * FROM resource_index
			WHERE title LIKE ? OR summary LIKE ? OR tags_json LIKE ?
			ORDER BY updated_at DESC
			LIMIT ?
		`).bind(normalized, normalized, normalized, limit).all<ResourceRow>()
		: await env.DB.prepare("SELECT * FROM resource_index ORDER BY updated_at DESC LIMIT ?").bind(limit).all<ResourceRow>();

	return (result.results ?? []).map(mapResource);
}

export async function searchReferenceTargets(env: Env, query: string, limit = 20): Promise<ReferenceTarget[]> {
	const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
	const [resources, extensions] = await Promise.all([
		searchResources(env, query, boundedLimit),
		listExtensions(env),
	]);
	const normalizedQuery = normalizeReferenceQuery(query);
	const resourceTargets = resources.map(referenceTargetForResource);
	const routeTargets = extensions
		.filter((extension) => extension.status !== "disabled")
		.flatMap((extension) => extension.routes.map((route) => ({
			id: `app-route:${route.path}`,
			label: route.label,
			description: route.description || extension.description,
			sourceApp: extension.slug,
			sourceType: "app-route",
			sourceId: route.path,
			href: route.path,
			referenceKind: "app-route" as const,
			updatedAt: "1970-01-01T00:00:00.000Z",
		} satisfies ReferenceTarget)))
		.filter((target) => referenceTargetMatches(target, normalizedQuery));

	return dedupeReferenceTargets([...routeTargets, ...resourceTargets])
		.sort((left, right) => compareReferenceTargets(left, right, normalizedQuery))
		.slice(0, boundedLimit);
}

export async function upsertResourceIndex(env: Env, record: ResourceIndexRecord): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO resource_index
			(id, source_app, source_type, source_id, title, summary, url, tags_json, relationships_json, occurred_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			summary = excluded.summary,
			url = excluded.url,
			tags_json = excluded.tags_json,
			relationships_json = excluded.relationships_json,
			occurred_at = excluded.occurred_at,
			updated_at = excluded.updated_at
	`).bind(
		record.id,
		record.sourceApp,
		record.sourceType,
		record.sourceId,
		record.title,
		record.summary,
		record.url,
		JSON.stringify(record.tags),
		JSON.stringify(record.relationships),
		record.occurredAt,
		record.createdAt,
		record.updatedAt,
	).run();
}

export async function upsertExtensionResourceIndex(env: Env, extension: RegisteredExtension, input: {
	sourceType: string;
	sourceId: string;
	title: string;
	summary?: string;
	url?: string | null;
	tags?: string[];
	relationships?: JsonObject[];
	occurredAt?: string | null;
	now?: string;
}): Promise<ResourceIndexRecord> {
	const sourceType = input.sourceType.trim();
	const sourceId = input.sourceId.trim();
	const title = input.title.trim();
	if (!sourceType || !sourceId || !title) {
		throw new Response(JSON.stringify({ error: "Resource records require sourceType, sourceId, and title." }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	if (!extension.indexProjections.some((projection) => projection.sourceType === sourceType)) {
		throw new Response(JSON.stringify({
			error: "Resource sourceType is not declared by app",
			app: extension.slug,
			sourceType,
		}), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
	if (input.url && !isAppScopedUrl(input.url, extension.slug)) {
		throw new Response(JSON.stringify({
			error: "Resource URL must stay under app route",
			app: extension.slug,
		}), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}

	const now = input.now ?? isoNow();
	const record: ResourceIndexRecord = {
		id: `${extension.slug}:${sourceType}:${sourceId}`,
		sourceApp: extension.slug,
		sourceType,
		sourceId,
		title,
		summary: input.summary?.trim() ?? "",
		url: input.url?.trim() || null,
		tags: normalizeStringList(input.tags ?? []),
		relationships: input.relationships ?? [],
		occurredAt: input.occurredAt ?? null,
		createdAt: now,
		updatedAt: now,
	};

	await upsertResourceIndex(env, record);
	return record;
}

export async function createBookmark(env: Env, input: { title: string; url: string; description?: string; tags?: string[] }): Promise<Bookmark> {
	const now = isoNow();
	const bookmark: Bookmark = {
		id: crypto.randomUUID(),
		title: input.title.trim(),
		url: input.url.trim(),
		description: input.description?.trim() ?? "",
		tags: input.tags ?? [],
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO bookmarks (id, title, url, description, tags_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).bind(bookmark.id, bookmark.title, bookmark.url, bookmark.description, JSON.stringify(bookmark.tags), now, now).run();

	await upsertResourceIndex(env, {
		id: `bookmark:${bookmark.id}`,
		sourceApp: "bookmarks",
		sourceType: "bookmark",
		sourceId: bookmark.id,
		title: bookmark.title,
		summary: bookmark.description,
		url: bookmark.url,
		tags: bookmark.tags,
		relationships: [],
		occurredAt: now,
		createdAt: now,
		updatedAt: now,
	});

	return bookmark;
}

export async function listBookmarks(env: Env, tag?: string): Promise<Bookmark[]> {
	const result = tag
		? await env.DB.prepare("SELECT * FROM bookmarks WHERE tags_json LIKE ? ORDER BY created_at DESC").bind(`%${tag}%`).all<BookmarkRow>()
		: await env.DB.prepare("SELECT * FROM bookmarks ORDER BY created_at DESC LIMIT 50").all<BookmarkRow>();
	return (result.results ?? []).map(mapBookmark);
}

export async function createProject(env: Env, input: { name: string; description?: string }): Promise<Project> {
	const now = isoNow();
	const project: Project = {
		id: crypto.randomUUID(),
		name: input.name.trim(),
		description: input.description?.trim() ?? "",
		status: "active",
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO projects (id, name, description, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).bind(project.id, project.name, project.description, project.status, now, now).run();

	const boardId = crypto.randomUUID();
	await env.DB.prepare(`
		INSERT INTO kanban_boards (id, project_id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
	`).bind(boardId, project.id, `${project.name} board`, now, now).run();

	for (const [position, name] of ["Backlog", "Doing", "Done"].entries()) {
		await env.DB.prepare(`
			INSERT INTO kanban_columns (id, board_id, name, position, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`).bind(crypto.randomUUID(), boardId, name, position, now, now).run();
	}

	await upsertResourceIndex(env, {
		id: `project:${project.id}`,
		sourceApp: "projects",
		sourceType: "project",
		sourceId: project.id,
		title: project.name,
		summary: project.description,
		url: "/apps/projects",
		tags: ["project"],
		relationships: [],
		occurredAt: now,
		createdAt: now,
		updatedAt: now,
	});

	return project;
}

export async function listProjects(env: Env): Promise<Project[]> {
	const result = await env.DB.prepare("SELECT * FROM projects ORDER BY updated_at DESC LIMIT 50").all<ProjectRow>();
	return (result.results ?? []).map(mapProject);
}

export async function listBoards(env: Env): Promise<Array<KanbanBoard & { columns: Array<KanbanColumn & { cards: KanbanCard[] }> }>> {
	const boardRows = await env.DB.prepare("SELECT * FROM kanban_boards ORDER BY updated_at DESC").all<BoardRow>();
	const columnRows = await env.DB.prepare("SELECT * FROM kanban_columns ORDER BY position ASC").all<ColumnRow>();
	const cardRows = await env.DB.prepare("SELECT * FROM kanban_cards ORDER BY position ASC").all<CardRow>();

	const cards = (cardRows.results ?? []).map(mapCard);
	const columns = (columnRows.results ?? []).map(mapColumn);

	return (boardRows.results ?? []).map((row) => {
		const board = mapBoard(row);
		return {
			...board,
			columns: columns
				.filter((column) => column.boardId === board.id)
				.map((column) => ({
					...column,
					cards: cards.filter((card) => card.columnId === column.id),
				})),
		};
	});
}

export async function createKanbanCard(env: Env, input: { boardId?: string; columnId?: string; title: string; description?: string }): Promise<KanbanCard> {
	const boards = await listBoards(env);
	const board = input.boardId ? boards.find((entry) => entry.id === input.boardId) : boards[0];
	if (!board) {
		throw new Response(JSON.stringify({ error: "No board exists." }), { status: 400, headers: { "content-type": "application/json" } });
	}
	const column = input.columnId ? board.columns.find((entry) => entry.id === input.columnId) : board.columns[0];
	if (!column) {
		throw new Response(JSON.stringify({ error: "No column exists." }), { status: 400, headers: { "content-type": "application/json" } });
	}

	const now = isoNow();
	const card: KanbanCard = {
		id: crypto.randomUUID(),
		boardId: board.id,
		columnId: column.id,
		title: input.title.trim(),
		description: input.description?.trim() ?? "",
		position: column.cards.length,
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO kanban_cards (id, board_id, column_id, title, description, position, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(card.id, card.boardId, card.columnId, card.title, card.description, card.position, now, now).run();

	await upsertResourceIndex(env, {
		id: `kanban-card:${card.id}`,
		sourceApp: "projects",
		sourceType: "kanban-card",
		sourceId: card.id,
		title: card.title,
		summary: card.description,
		url: "/apps/projects",
		tags: ["kanban-card"],
		relationships: [{ type: "board", id: board.id }],
		occurredAt: now,
		createdAt: now,
		updatedAt: now,
	});

	return card;
}

export async function listScheduledWorkflows(env: Env): Promise<ScheduledWorkflow[]> {
	const result = await env.DB.prepare("SELECT * FROM scheduled_workflows ORDER BY name ASC").all<WorkflowRow>();
	return (result.results ?? []).map(mapWorkflow);
}

export async function listEnabledScheduledWorkflows(env: Env): Promise<ScheduledWorkflow[]> {
	const result = await env.DB.prepare("SELECT * FROM scheduled_workflows WHERE enabled = 1 ORDER BY name ASC").all<WorkflowRow>();
	return (result.results ?? []).map(mapWorkflow);
}

export async function getScheduledWorkflow(env: Env, id: string): Promise<ScheduledWorkflow | null> {
	const row = await env.DB.prepare("SELECT * FROM scheduled_workflows WHERE id = ?").bind(id).first<WorkflowRow>();
	return row ? mapWorkflow(row) : null;
}

export async function setScheduledWorkflowEnabled(env: Env, id: string, enabled: boolean): Promise<ScheduledWorkflow | null> {
	const updatedAt = isoNow();
	await env.DB.prepare(`
		UPDATE scheduled_workflows
		SET enabled = ?, updated_at = ?
		WHERE id = ?
	`).bind(enabled ? 1 : 0, updatedAt, id).run();
	return getScheduledWorkflow(env, id);
}

export async function recordScheduledWorkflowAttempt(env: Env, id: string, attemptedAt: string): Promise<void> {
	await env.DB.prepare(`
		UPDATE scheduled_workflows
		SET last_run_at = ?, updated_at = ?
		WHERE id = ?
	`).bind(attemptedAt, attemptedAt, id).run();
}

export async function listMiniAppAudit(env: Env, limit = 12, slug?: string): Promise<MiniAppAuditRecord[]> {
	const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
	const query = slug
		? env.DB.prepare("SELECT * FROM mini_app_audit WHERE slug = ? ORDER BY created_at DESC LIMIT ?").bind(slug, boundedLimit)
		: env.DB.prepare("SELECT * FROM mini_app_audit ORDER BY created_at DESC LIMIT ?").bind(boundedLimit);
	const result = await query.all<MiniAppAuditRow>();
	return (result.results ?? []).map(mapMiniAppAudit);
}

export async function createAuditRecord(env: Env, input: { slug: string; action: string; status: string; details: JsonObject }): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO mini_app_audit (id, slug, action, status, details_json, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).bind(crypto.randomUUID(), input.slug, input.action, input.status, JSON.stringify(input.details), isoNow()).run();
}

export async function createMiniAppBuild(env: Env, input: {
	prompt: string;
	operation: "create" | "update";
	targetSlug?: string;
	slugHint?: string;
	autonomousDeploy?: boolean;
	maxAttempts?: number;
	deadlineAt?: string;
}): Promise<MiniAppBuild> {
	const now = isoNow();
	const build: MiniAppBuild = {
		id: crypto.randomUUID(),
		prompt: input.prompt,
		operation: input.operation,
		targetSlug: input.targetSlug ?? null,
		slugHint: input.slugHint ?? null,
		autonomousDeploy: input.autonomousDeploy ?? true,
		status: "pending",
		attemptCount: 0,
		maxAttempts: Math.max(1, Math.trunc(input.maxAttempts ?? 3)),
		currentRunId: null,
		result: null,
		error: null,
		deadlineAt: input.deadlineAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
		completedAt: null,
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO mini_app_builds
			(id, prompt, operation, target_slug, slug_hint, autonomous_deploy, status, attempt_count, max_attempts, current_run_id, result_json, error_json, deadline_at, completed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		build.id,
		build.prompt,
		build.operation,
		build.targetSlug,
		build.slugHint,
		build.autonomousDeploy ? 1 : 0,
		build.status,
		build.attemptCount,
		build.maxAttempts,
		build.currentRunId,
		null,
		null,
		build.deadlineAt,
		build.completedAt,
		build.createdAt,
		build.updatedAt,
	).run();

	await appendMiniAppBuildEvent(env, {
		buildId: build.id,
		type: "queued",
		message: `Queued ${build.operation} build. Deadline ${build.deadlineAt}.`,
		details: {
			deadlineAt: build.deadlineAt,
			maxAttempts: build.maxAttempts,
			operation: build.operation,
			slugHint: build.slugHint,
			targetSlug: build.targetSlug,
		},
	});

	return build;
}

export async function getMiniAppBuild(env: Env, id: string): Promise<MiniAppBuild | null> {
	try {
		const row = await env.DB.prepare("SELECT * FROM mini_app_builds WHERE id = ?").bind(id).first<MiniAppBuildRow>();
		return row ? mapMiniAppBuild(row) : null;
	} catch (error) {
		if (isMissingMiniAppBuildStorage(error)) {
			return null;
		}
		throw error;
	}
}

export async function listRecoverableMiniAppBuilds(env: Env, now = isoNow()): Promise<MiniAppBuild[]> {
	try {
		const result = await env.DB.prepare(`
			SELECT * FROM mini_app_builds
			WHERE status IN ('pending', 'interrupted')
				AND attempt_count < max_attempts
				AND deadline_at > ?
			ORDER BY updated_at ASC
			LIMIT 10
		`).bind(now).all<MiniAppBuildRow>();
		return (result.results ?? []).map(mapMiniAppBuild);
	} catch (error) {
		if (isMissingMiniAppBuildStorage(error)) {
			return [];
		}
		throw error;
	}
}

export async function markMiniAppBuildRunning(env: Env, input: {
	id: string;
	runId: string;
	attempt: number;
}): Promise<MiniAppBuild | null> {
	const updatedAt = isoNow();
	await env.DB.prepare(`
		UPDATE mini_app_builds
		SET status = 'running',
			current_run_id = ?,
			attempt_count = ?,
			error_json = NULL,
			updated_at = ?
		WHERE id = ?
	`).bind(input.runId, Math.max(1, Math.trunc(input.attempt)), updatedAt, input.id).run();
	await appendMiniAppBuildEvent(env, {
		buildId: input.id,
		type: "running",
		message: `Attempt ${Math.max(1, Math.trunc(input.attempt))} dispatched as submission ${input.runId}.`,
		details: {
			attempt: Math.max(1, Math.trunc(input.attempt)),
			submissionId: input.runId,
		},
	});
	return getMiniAppBuild(env, input.id);
}

export async function completeMiniAppBuild(env: Env, input: {
	id: string;
	result: JsonObject;
	status?: "completed" | "failed";
	error?: JsonObject;
}): Promise<MiniAppBuild | null> {
	const now = isoNow();
	await env.DB.prepare(`
		UPDATE mini_app_builds
		SET status = ?,
			result_json = ?,
			error_json = ?,
			completed_at = ?,
			updated_at = ?
		WHERE id = ?
	`).bind(
		input.status ?? "completed",
		JSON.stringify(input.result),
		input.error ? JSON.stringify(input.error) : null,
		now,
		now,
		input.id,
	).run();
	await appendMiniAppBuildEvent(env, {
		buildId: input.id,
		type: input.status ?? "completed",
		message: input.status === "failed"
			? "Mini app build finished without an activatable app."
			: "Mini app build completed.",
		details: {
			error: input.error ?? null,
			result: input.result,
		},
	});
	return getMiniAppBuild(env, input.id);
}

export async function failMiniAppBuild(env: Env, input: {
	id: string;
	status?: Exclude<MiniAppBuildStatus, "pending" | "running" | "completed">;
	error: JsonObject;
}): Promise<MiniAppBuild | null> {
	const now = isoNow();
	await env.DB.prepare(`
		UPDATE mini_app_builds
		SET status = ?,
			error_json = ?,
			completed_at = CASE WHEN ? IN ('failed', 'expired') THEN ? ELSE completed_at END,
			updated_at = ?
		WHERE id = ?
	`).bind(input.status ?? "failed", JSON.stringify(input.error), input.status ?? "failed", now, now, input.id).run();
	await appendMiniAppBuildEvent(env, {
		buildId: input.id,
		type: input.status ?? "failed",
		message: readEventMessage(input.error, "Mini app build failed."),
		details: {
			error: input.error,
		},
	});
	return getMiniAppBuild(env, input.id);
}

export async function expireMiniAppBuild(env: Env, id: string, now = isoNow()): Promise<MiniAppBuild | null> {
	await env.DB.prepare(`
		UPDATE mini_app_builds
		SET status = 'expired',
			error_json = ?,
			completed_at = ?,
			updated_at = ?
		WHERE id = ?
			AND status IN ('pending', 'running', 'interrupted')
	`).bind(JSON.stringify({ message: "Mini app build exceeded its 30 minute deadline." }), now, now, id).run();
	await appendMiniAppBuildEvent(env, {
		buildId: id,
		type: "expired",
		message: "Mini app build exceeded its 30 minute deadline.",
		details: {},
	});
	return getMiniAppBuild(env, id);
}

export async function appendMiniAppBuildEvent(env: Env, input: {
	buildId: string;
	type: string;
	message: string;
	details?: JsonObject;
}): Promise<MiniAppBuildEvent | null> {
	try {
		const sequenceRow = await env.DB.prepare(`
			SELECT COALESCE(MAX(sequence) + 1, 0) AS next_sequence
			FROM mini_app_build_events
			WHERE build_id = ?
		`).bind(input.buildId).first<{ next_sequence: number }>();
		const sequence = Number(sequenceRow?.next_sequence ?? 0);
		const event: MiniAppBuildEvent = {
			id: crypto.randomUUID(),
			buildId: input.buildId,
			sequence,
			type: input.type,
			message: input.message,
			details: input.details ?? {},
			createdAt: isoNow(),
		};
		await env.DB.prepare(`
			INSERT INTO mini_app_build_events
				(id, build_id, sequence, type, message, details_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).bind(
			event.id,
			event.buildId,
			event.sequence,
			event.type,
			event.message,
			JSON.stringify(event.details),
			event.createdAt,
		).run();
		return event;
	} catch (error) {
		if (isMissingMiniAppBuildEventStorage(error)) {
			return null;
		}
		throw error;
	}
}

export async function listMiniAppBuildEvents(env: Env, buildId: string, options: {
	afterSequence?: number;
	limit?: number;
} = {}): Promise<MiniAppBuildEvent[]> {
	try {
		const afterSequence = Number.isFinite(options.afterSequence) ? Number(options.afterSequence) : -1;
		const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
		const result = await env.DB.prepare(`
			SELECT * FROM mini_app_build_events
			WHERE build_id = ?
				AND sequence > ?
			ORDER BY sequence ASC
			LIMIT ?
		`).bind(buildId, afterSequence, limit).all<MiniAppBuildEventRow>();
		return (result.results ?? []).map(mapMiniAppBuildEvent);
	} catch (error) {
		if (isMissingMiniAppBuildEventStorage(error)) {
			return [];
		}
		throw error;
	}
}

export async function createExtensionBindingRequest(env: Env, input: {
	operation: "create" | "update";
	manifest: ExtensionManifest;
	workerSource: string;
	deploymentNotes: string;
	issues: string[];
	status?: ExtensionBindingRequestStatus;
}): Promise<ExtensionBindingRequest> {
	if (input.manifest.bindings.length === 0) {
		throw new Error("Extension binding request requires at least one manifest binding.");
	}

	const now = isoNow();
	const request: ExtensionBindingRequest = {
		id: crypto.randomUUID(),
		extensionSlug: input.manifest.slug,
		extensionName: input.manifest.name,
		operation: input.operation,
		manifest: input.manifest,
		workerSource: input.workerSource,
		deploymentNotes: input.deploymentNotes,
		bindings: input.manifest.bindings,
		resolvedBindings: [],
		issues: input.issues,
		status: input.status ?? "pending",
		createdAt: now,
		updatedAt: now,
	};

	await env.DB.prepare(`
		INSERT INTO extension_binding_requests
			(id, extension_slug, extension_name, operation, manifest_json, worker_source, deployment_notes, bindings_json, issues_json, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		request.id,
		request.extensionSlug,
		request.extensionName,
		request.operation,
		JSON.stringify(request.manifest),
		request.workerSource,
		request.deploymentNotes,
		JSON.stringify(request.bindings),
		JSON.stringify(request.issues),
		request.status,
		request.createdAt,
		request.updatedAt,
	).run();

	return request;
}

export async function listExtensionBindingRequests(
	env: Env,
	options: { limit?: number; status?: ExtensionBindingRequestStatus } = {},
): Promise<ExtensionBindingRequest[]> {
	const boundedLimit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
	const query = options.status
		? env.DB.prepare("SELECT * FROM extension_binding_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(options.status, boundedLimit)
		: env.DB.prepare("SELECT * FROM extension_binding_requests ORDER BY created_at DESC LIMIT ?").bind(boundedLimit);
	let result;
	try {
		result = await query.all<ExtensionBindingRequestRow>();
	} catch (error) {
		if (isMissingExtensionBindingRequestStorage(error)) {
			return [];
		}
		throw error;
	}
	return (result.results ?? []).map(mapExtensionBindingRequest);
}

export async function getAppSnapshot(env: Env, principal: Principal, date = todayDateKey()): Promise<AppSnapshot> {
	await ensureBuiltins(env);

	const dailyNote = await getOrCreateDailyNote(env, date);
	const recentNotes = await listRecentDailyNotes(env, 10, addDays(date, 1));
	const extensions = await listExtensions(env);
	const commands = extensions.flatMap((extension) => extension.commands);
	const editorBlocks = extensions.flatMap((extension) => extension.editorBlocks);
	const bindingRequests = await listExtensionBindingRequests(env, { limit: 20 });
	const scheduledWorkflows = await listScheduledWorkflows(env);
	const miniAppAudit = await listMiniAppAudit(env, 8);
	const bookmarks = await listBookmarks(env);
	const projects = await listProjects(env);
	const boards = await listBoards(env);
	const resourceIndex = await searchResources(env, "", 12);

	return {
		dailyNote,
		recentNotes,
		extensions,
		commands,
		editorBlocks,
		bindingRequests,
		scheduledWorkflows,
		miniAppAudit,
		bookmarks,
		projects,
		boards,
		resourceIndex,
		principal,
	};
}

async function ensureDemoData(env: Env): Promise<void> {
	const bookmarkCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM bookmarks").first<{ count: number }>();
	if ((bookmarkCount?.count ?? 0) === 0) {
		await createBookmark(env, {
			title: "Flue Cloudflare target",
			url: "https://flueframework.com/docs/guide/targets/cloudflare/",
			description: "Cloudflare target behavior for agents, workflows, and generated Durable Objects.",
			tags: ["flue", "cloudflare", "agents"],
		});
		await createBookmark(env, {
			title: "Workers for Platforms dynamic dispatch",
			url: "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/",
			description: "Dynamic dispatch Worker routing for autonomous mini apps.",
			tags: ["cloudflare", "mini-apps"],
		});
	}

	const projectCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>();
	if ((projectCount?.count ?? 0) === 0) {
		const project = await createProject(env, {
			name: "Enchiridion platform",
			description: "Private second brain host, extension registry, daily notes, and agentic mini apps.",
		});
		const board = (await listBoards(env)).find((entry) => entry.projectId === project.id);
		if (board?.columns[0]) {
			await createKanbanCard(env, {
				boardId: board.id,
				columnId: board.columns[0].id,
				title: "Wire Daily Notes to D1",
				description: "Autosave Tiptap JSON and mirror text into the resource graph.",
			});
			await createKanbanCard(env, {
				boardId: board.id,
				columnId: board.columns[0].id,
				title: "Validate mini-app manifests",
				description: "Block undeclared permissions before autonomous deploy.",
			});
		}
	}
}

function mapDailyNote(row: DailyNoteRow): DailyNote {
	return {
		id: row.id,
		date: row.date,
		title: titleForDailyNote(row.date),
		documentJson: parseJsonObject(row.document_json, emptyTiptapDocument()),
		textContent: row.text_content,
		version: row.version,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapExtension(row: ExtensionRow): ExtensionManifest {
	const manifest = parseJsonObject(row.manifest_json) as unknown as ExtensionManifest;
	return { ...manifest, status: row.status };
}

function mapRegisteredExtension(row: ExtensionRow): RegisteredExtension {
	return { ...mapExtension(row), deployedScriptName: row.deployed_script_name };
}

function mapMiniAppAudit(row: MiniAppAuditRow): MiniAppAuditRecord {
	return {
		id: row.id,
		slug: row.slug,
		action: row.action,
		status: row.status,
		details: parseJsonObject(row.details_json),
		createdAt: row.created_at,
	};
}

function mapMiniAppBuild(row: MiniAppBuildRow): MiniAppBuild {
	return {
		id: row.id,
		prompt: row.prompt,
		operation: row.operation,
		targetSlug: row.target_slug,
		slugHint: row.slug_hint,
		autonomousDeploy: row.autonomous_deploy === 1,
		status: row.status,
		attemptCount: row.attempt_count,
		maxAttempts: row.max_attempts,
		currentRunId: row.current_run_id,
		result: row.result_json ? parseJsonObject(row.result_json) : null,
		error: row.error_json ? parseJsonObject(row.error_json) : null,
		deadlineAt: row.deadline_at,
		completedAt: row.completed_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapMiniAppBuildEvent(row: MiniAppBuildEventRow): MiniAppBuildEvent {
	return {
		id: row.id,
		buildId: row.build_id,
		sequence: row.sequence,
		type: row.type,
		message: row.message,
		details: parseJsonObject(row.details_json),
		createdAt: row.created_at,
	};
}

function mapExtensionBindingRequest(row: ExtensionBindingRequestRow): ExtensionBindingRequest {
	const manifest = parseJsonObject(row.manifest_json) as unknown as ExtensionManifest;
	return {
		id: row.id,
		extensionSlug: row.extension_slug,
		extensionName: row.extension_name,
		operation: row.operation,
		manifest,
		workerSource: row.worker_source,
		deploymentNotes: row.deployment_notes,
		bindings: parseJsonArray(row.bindings_json),
		resolvedBindings: parseJsonArray(row.resolved_bindings_json),
		issues: parseJsonArray<string>(row.issues_json),
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapResource(row: ResourceRow): ResourceIndexRecord {
	return {
		id: row.id,
		sourceApp: row.source_app,
		sourceType: row.source_type,
		sourceId: row.source_id,
		title: row.title,
		summary: row.summary,
		url: row.url,
		tags: parseJsonArray<string>(row.tags_json),
		relationships: parseJsonArray<JsonObject>(row.relationships_json),
		occurredAt: row.occurred_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function referenceTargetForResource(record: ResourceIndexRecord): ReferenceTarget {
	return {
		id: record.id,
		label: record.title,
		description: record.summary || record.tags.join(", ") || humanizeReferenceType(record.sourceType),
		sourceApp: record.sourceApp,
		sourceType: record.sourceType,
		sourceId: record.sourceId,
		href: record.url,
		referenceKind: referenceKindForResource(record),
		updatedAt: record.updatedAt,
	};
}

function referenceKindForResource(record: ResourceIndexRecord): ReferenceTarget["referenceKind"] {
	if (record.sourceApp === "notes" && record.sourceType === "daily-note") {
		return "daily-note";
	}
	if (record.url && /^https?:\/\//i.test(record.url)) {
		return "external";
	}
	return "resource";
}

function dedupeReferenceTargets(targets: ReferenceTarget[]): ReferenceTarget[] {
	const seen = new Set<string>();
	const deduped: ReferenceTarget[] = [];
	for (const target of targets) {
		if (seen.has(target.id)) {
			continue;
		}
		seen.add(target.id);
		deduped.push(target);
	}
	return deduped;
}

function compareReferenceTargets(left: ReferenceTarget, right: ReferenceTarget, query: string): number {
	const leftScore = referenceTargetScore(left, query);
	const rightScore = referenceTargetScore(right, query);
	if (leftScore !== rightScore) {
		return rightScore - leftScore;
	}
	return right.updatedAt.localeCompare(left.updatedAt);
}

function referenceTargetScore(target: ReferenceTarget, query: string): number {
	if (!query) {
		return target.referenceKind === "app-route" ? 1 : 0;
	}
	const label = normalizeReferenceQuery(target.label);
	const source = normalizeReferenceQuery(`${target.sourceApp} ${target.sourceType}`);
	if (label === query) {
		return 100;
	}
	if (label.startsWith(query)) {
		return 80;
	}
	if (label.includes(query)) {
		return 60;
	}
	if (source.includes(query)) {
		return 40;
	}
	return 0;
}

function referenceTargetMatches(target: ReferenceTarget, query: string): boolean {
	if (!query) {
		return true;
	}
	return normalizeReferenceQuery(`${target.label} ${target.description} ${target.sourceApp} ${target.sourceType}`).includes(query);
}

function normalizeReferenceQuery(value: string): string {
	return value.trim().toLowerCase();
}

function humanizeReferenceType(value: string): string {
	return value.replace(/[-_]/g, " ");
}

function normalizeStringList(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isAppScopedUrl(url: string, slug: string): boolean {
	const trimmed = url.trim();
	const root = `/apps/${slug}`;
	return trimmed === root || trimmed.startsWith(`${root}/`);
}

function mapBookmark(row: BookmarkRow): Bookmark {
	return {
		id: row.id,
		title: row.title,
		url: row.url,
		description: row.description,
		tags: parseJsonArray<string>(row.tags_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapBoard(row: BoardRow): KanbanBoard {
	return {
		id: row.id,
		projectId: row.project_id,
		name: row.name,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapColumn(row: ColumnRow): KanbanColumn {
	return {
		id: row.id,
		boardId: row.board_id,
		name: row.name,
		position: row.position,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapCard(row: CardRow): KanbanCard {
	return {
		id: row.id,
		boardId: row.board_id,
		columnId: row.column_id,
		title: row.title,
		description: row.description,
		position: row.position,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapWorkflow(row: WorkflowRow): ScheduledWorkflow {
	return {
		id: row.id,
		extensionSlug: row.extension_slug,
		name: row.name,
		cron: row.cron,
		workflowName: row.workflow_name,
		payload: parseJsonObject(row.payload_json),
		enabled: row.enabled === 1,
		lastRunAt: row.last_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function isMissingExtensionBindingRequestStorage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("extension_binding_requests") && /no such table|not found|does not exist/i.test(message);
}

function isMissingMiniAppBuildStorage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("mini_app_builds") && /no such table|not found|does not exist/i.test(message);
}

function isMissingMiniAppBuildEventStorage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("mini_app_build_events") && /no such table|not found|does not exist/i.test(message);
}

function readEventMessage(details: JsonObject, fallback: string): string {
	const message = details.message;
	if (typeof message === "string" && message.trim()) {
		return message.trim();
	}
	const error = details.error;
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const errorMessage = (error as JsonObject).message;
		if (typeof errorMessage === "string" && errorMessage.trim()) {
			return errorMessage.trim();
		}
	}
	return fallback;
}
