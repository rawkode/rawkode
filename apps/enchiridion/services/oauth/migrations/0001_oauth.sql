PRAGMA foreign_keys = ON;

CREATE TABLE oauth_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_sessions (
  state_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  browser_binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_sessions_expiry ON oauth_sessions(expires_at);

CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect_required')),
  version INTEGER NOT NULL DEFAULT 1,
  refresh_lease TEXT,
  refresh_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (app_id, owner_id, account_id)
);
CREATE INDEX oauth_connections_owner ON oauth_connections(owner_id);

CREATE TABLE oauth_service_grants (
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, service_id)
);
