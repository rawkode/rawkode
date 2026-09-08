CREATE TABLE calendar_syncs (
  connection_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  sync_token TEXT,
  synced_at INTEGER,
  lease TEXT,
  lease_until INTEGER
);
CREATE TABLE calendar_events (
  connection_id TEXT NOT NULL REFERENCES calendar_syncs(connection_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (connection_id, event_id)
);
CREATE TABLE calendar_staging (
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  cancelled INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_id)
);
