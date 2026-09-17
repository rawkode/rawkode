import type { Connection, OAuthApp } from "@enchiridion/oauth-client/contracts";
import type { OAuthEnv } from "./env";
import { provider } from "./providers";

export interface AppRow {
  id: string; name: string; provider_id: string; client_id: string; client_secret: string; scopes: string; created_at: number;
}
export interface SessionRow {
  state_hash: string; app_id: string; owner_id: string; browser_binding_hash: string; verifier: string; nonce: string; expires_at: number;
}
export interface ConnectionRow {
  id: string; app_id: string; owner_id: string; account_id: string; account_label: string; scopes: string;
  access_token: string | null; refresh_token: string | null; expires_at: number;
  status: "connected" | "reconnect_required"; version: number; refresh_lease: string | null; refresh_lease_until: number | null;
  created_at: number;
}

export function publicApp(row: AppRow, env: OAuthEnv): OAuthApp {
  return { id: row.id, name: row.name, providerId: row.provider_id, clientId: row.client_id,
    scopes: JSON.parse(row.scopes), redirectUri: provider(row.provider_id, env).redirectUri, createdAt: row.created_at };
}

export async function listConnections(db: D1Database, filter: { ownerId: string } | { serviceId: string }): Promise<Connection[]> {
  const where = "ownerId" in filter ? "c.owner_id = ?" : "EXISTS (SELECT 1 FROM oauth_service_grants g WHERE g.connection_id = c.id AND g.service_id = ?)";
  const value = "ownerId" in filter ? filter.ownerId : filter.serviceId;
  const { results } = await db.prepare(`SELECT c.id, c.app_id, c.owner_id, c.account_id, c.account_label, c.scopes,
    c.status, c.expires_at, c.created_at, a.name AS app_name, a.provider_id,
    (SELECT json_group_array(g.service_id) FROM oauth_service_grants g WHERE g.connection_id = c.id) AS services
    FROM oauth_connections c JOIN oauth_apps a ON a.id = c.app_id WHERE ${where} ORDER BY c.created_at DESC, c.id`).bind(value)
    .all<ConnectionRow & { app_name: string; provider_id: string; services: string }>();
  return results.map((row) => ({ id: row.id, ownerId: row.owner_id, appId: row.app_id, appName: row.app_name,
    providerId: row.provider_id, accountId: row.account_id, accountLabel: row.account_label,
    scopes: JSON.parse(row.scopes), status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, services: JSON.parse(row.services) }));
}
