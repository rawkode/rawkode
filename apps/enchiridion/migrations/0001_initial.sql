CREATE TABLE IF NOT EXISTS daily_notes (
	id TEXT PRIMARY KEY,
	date TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	document_json TEXT NOT NULL,
	text_content TEXT NOT NULL DEFAULT '',
	version INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_daily_notes_date ON daily_notes(date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_notes_text ON daily_notes(text_content);

CREATE TABLE IF NOT EXISTS extension_manifests (
	slug TEXT PRIMARY KEY,
	manifest_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('dynamic', 'promoted', 'disabled', 'builtin')),
	deployed_script_name TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_index (
	id TEXT PRIMARY KEY,
	source_app TEXT NOT NULL,
	source_type TEXT NOT NULL,
	source_id TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	url TEXT,
	tags_json TEXT NOT NULL DEFAULT '[]',
	relationships_json TEXT NOT NULL DEFAULT '[]',
	occurred_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_source ON resource_index(source_app, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_resource_title ON resource_index(title);

CREATE TABLE IF NOT EXISTS mini_app_audit (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL,
	action TEXT NOT NULL,
	status TEXT NOT NULL,
	details_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_workflows (
	id TEXT PRIMARY KEY,
	extension_slug TEXT,
	name TEXT NOT NULL,
	cron TEXT NOT NULL,
	workflow_name TEXT NOT NULL,
	payload_json TEXT NOT NULL DEFAULT '{}',
	enabled INTEGER NOT NULL DEFAULT 1,
	last_run_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	url TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	tags_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_title ON bookmarks(title);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);

CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_boards (
	id TEXT PRIMARY KEY,
	project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_columns (
	id TEXT PRIMARY KEY,
	board_id TEXT NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	position INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_cards (
	id TEXT PRIMARY KEY,
	board_id TEXT NOT NULL REFERENCES kanban_boards(id) ON DELETE CASCADE,
	column_id TEXT NOT NULL REFERENCES kanban_columns(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	position INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
