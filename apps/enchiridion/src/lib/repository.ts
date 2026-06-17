import { addDays, isoNow, titleForDailyNote, todayDateKey } from "./dates";
import { builtinExtensionManifests, builtinScheduledWorkflows } from "./seed";
import { emptyTiptapDocument, extractTextFromTiptap, parseJsonArray, parseJsonObject } from "./text";
import type {
	AppSnapshot,
	Bookmark,
	DailyNote,
	Env,
	ExtensionManifest,
	JsonObject,
	KanbanBoard,
	KanbanCard,
	KanbanColumn,
	MiniAppAuditRecord,
	Principal,
	Project,
	RegisteredExtension,
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

export async function getAppSnapshot(env: Env, principal: Principal, date = todayDateKey()): Promise<AppSnapshot> {
	await ensureBuiltins(env);

	const dailyNote = await getOrCreateDailyNote(env, date);
	const recentNotes = await listRecentDailyNotes(env, 10, addDays(date, 1));
	const extensions = await listExtensions(env);
	const commands = extensions.flatMap((extension) => extension.commands);
	const editorBlocks = extensions.flatMap((extension) => extension.editorBlocks);
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
		title: row.title,
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
