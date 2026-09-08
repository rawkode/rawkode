-- Keep the legacy primary-calendar tables intact during the transition.
CREATE TABLE google_syncs (
  connection_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  sync_token TEXT,
  page_token TEXT,
  generation TEXT NOT NULL,
  synced_at INTEGER,
  lease TEXT,
  lease_until INTEGER,
  PRIMARY KEY (connection_id, collection)
);
CREATE TABLE google_records (
  connection_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(connection_id, collection, resource_id)
);
CREATE TABLE google_staging (
  generation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  deleted INTEGER NOT NULL,
  PRIMARY KEY(generation, resource_id)
);
CREATE TABLE gmail_watches (
  connection_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expiration INTEGER NOT NULL,
  history_id TEXT NOT NULL,
  notified_at INTEGER,
  renewed_at INTEGER NOT NULL
);
