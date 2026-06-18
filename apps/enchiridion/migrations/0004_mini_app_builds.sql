CREATE TABLE IF NOT EXISTS mini_app_builds (
	id TEXT PRIMARY KEY,
	prompt TEXT NOT NULL,
	operation TEXT NOT NULL CHECK(operation IN ('create', 'update')),
	target_slug TEXT,
	slug_hint TEXT,
	autonomous_deploy INTEGER NOT NULL DEFAULT 1,
	status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'interrupted', 'completed', 'failed', 'expired')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL DEFAULT 3,
	current_run_id TEXT,
	result_json TEXT,
	error_json TEXT,
	deadline_at TEXT NOT NULL,
	completed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mini_app_builds_status ON mini_app_builds(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mini_app_builds_deadline ON mini_app_builds(deadline_at);
CREATE INDEX IF NOT EXISTS idx_mini_app_builds_run ON mini_app_builds(current_run_id);
