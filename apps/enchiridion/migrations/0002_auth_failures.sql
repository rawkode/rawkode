CREATE TABLE IF NOT EXISTS auth_failures (
	key_hash TEXT PRIMARY KEY,
	failed_count INTEGER NOT NULL DEFAULT 0,
	first_failed_at TEXT NOT NULL,
	last_failed_at TEXT NOT NULL,
	locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_locked_until ON auth_failures(locked_until);
