CREATE TABLE IF NOT EXISTS extension_binding_requests (
	id TEXT PRIMARY KEY,
	extension_slug TEXT NOT NULL,
	extension_name TEXT NOT NULL,
	operation TEXT NOT NULL CHECK(operation IN ('create', 'update')),
	manifest_json TEXT NOT NULL,
	worker_source TEXT NOT NULL,
	deployment_notes TEXT NOT NULL DEFAULT '',
	bindings_json TEXT NOT NULL DEFAULT '[]',
	resolved_bindings_json TEXT NOT NULL DEFAULT '[]',
	issues_json TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL CHECK(status IN ('pending', 'provisioned', 'rejected')),
	deployed_script_name TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extension_binding_requests_status ON extension_binding_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extension_binding_requests_slug ON extension_binding_requests(extension_slug, created_at DESC);
