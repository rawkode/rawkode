CREATE TABLE IF NOT EXISTS mini_app_build_events (
	id TEXT PRIMARY KEY,
	build_id TEXT NOT NULL REFERENCES mini_app_builds(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	type TEXT NOT NULL,
	message TEXT NOT NULL,
	details_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mini_app_build_events_sequence ON mini_app_build_events(build_id, sequence);
CREATE INDEX IF NOT EXISTS idx_mini_app_build_events_created ON mini_app_build_events(build_id, created_at);
