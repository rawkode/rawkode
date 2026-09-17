import { RpcTarget } from "capnweb";
import * as oauth from "oauth4webapi";
import type { AccessToken, OAuthIntegrationApi } from "@enchiridion/oauth-client/contracts";
import type { OAuthEnv } from "./env";
import { serviceCredentials } from "./env";
import { sha256, TokenVault } from "./crypto";
import { OAuthError, requireScopes, requireString, safeCall } from "./errors";
import { normalizeScopes, provider } from "./providers";
import { listConnections, type AppRow, type ConnectionRow } from "./store";

export async function authenticateService(env: OAuthEnv, credential: string): Promise<string> {
  if (typeof credential !== "string" || credential.length < 32 || credential.length > 256) throw new OAuthError("Unauthorized integration.");
  const hash = await sha256(credential);
  const service = Object.entries(serviceCredentials(env)).find(([, expected]) => expected === hash)?.[0];
  if (!service) throw new OAuthError("Unauthorized integration.");
  return service;
}

export class IntegrationApi extends RpcTarget implements OAuthIntegrationApi {
  #env: OAuthEnv;
  #credential: string;
  constructor(env: OAuthEnv, credential: string) { super(); this.#env = env; this.#credential = credential; }

  listConnections() {
    return safeCall(async () => listConnections(this.#env.DB, { serviceId: await authenticateService(this.#env, this.#credential) }));
  }

  getAccessToken(connectionId: string, requiredScopes: string[]) {
    return safeCall(async () => {
      const service = await authenticateService(this.#env, this.#credential);
      const id = requireString(connectionId, "connection ID");
      const scopes = normalizeScopes(requireScopes(requiredScopes));
      for (let attempt = 0; attempt < 30; attempt++) {
        const row = await this.#authorized(id, service);
        if (scopes.some((scope) => !JSON.parse(row.scopes).includes(scope))) throw new OAuthError("The connected account has not granted the required scopes.");
        if (row.status !== "connected" || !row.refresh_token || !row.access_token) throw new OAuthError("Reconnect this account before requesting a token.");
        if (row.expires_at > Date.now() + 60_000) return this.#token(row, service);
        const lease = crypto.randomUUID();
        const acquired = await this.#env.DB.prepare(`UPDATE oauth_connections SET refresh_lease = ?, refresh_lease_until = ?
          WHERE id = ? AND version = ? AND (refresh_lease_until IS NULL OR refresh_lease_until < ?) RETURNING id`)
          .bind(lease, Date.now() + 30_000, id, row.version, Date.now()).first();
        if (acquired) return this.#refresh(row, lease, service, scopes);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new OAuthError("Token refresh is in progress. Retry shortly.");
    });
  }

  async #authorized(id: string, service: string): Promise<ConnectionRow> {
    const row = await this.#env.DB.prepare(`SELECT c.* FROM oauth_connections c JOIN oauth_service_grants g ON g.connection_id = c.id
      WHERE c.id = ? AND g.service_id = ?`).bind(id, service).first<ConnectionRow>();
    if (!row) throw new OAuthError("This integration is not authorized for the connection.");
    return row;
  }

  async #token(row: ConnectionRow, service: string): Promise<AccessToken> {
    const current = await this.#authorized(row.id, service);
    if (current.version !== row.version || !current.access_token || current.status !== "connected") throw new OAuthError("Connection changed. Retry the token request.");
    return { accessToken: await new TokenVault(this.#env).decrypt(current.access_token, `connection:${row.id}:access`),
      expiresAt: current.expires_at, tokenType: "Bearer", scopes: JSON.parse(current.scopes) };
  }

  async #refresh(row: ConnectionRow, lease: string, service: string, required: string[]): Promise<AccessToken> {
    const db = this.#env.DB;
    const vault = new TokenVault(this.#env);
    try {
      const app = await db.prepare("SELECT * FROM oauth_apps WHERE id = ?").bind(row.app_id).first<AppRow>();
      if (!app) throw new OAuthError("OAuth app not found.");
      const p = provider(app.provider_id, this.#env);
      const client = { client_id: app.client_id };
      const response = await oauth.refreshTokenGrantRequest(p.server, client,
        oauth.ClientSecretPost(await vault.decrypt(app.client_secret, `app:${app.id}:secret`)),
        await vault.decrypt(row.refresh_token!, `connection:${row.id}:refresh`), p.options);
      const tokens = await oauth.processRefreshTokenResponse(p.server, client, response);
      const scopes = normalizeScopes(tokens.scope?.split(" ").filter(Boolean) ?? JSON.parse(row.scopes));
      if (JSON.stringify(scopes) !== row.scopes || required.some((scope) => !scopes.includes(scope)) || tokens.token_type !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0) {
        await this.#invalidate(row, lease);
        throw new OAuthError("Account permissions changed. Reconnect the account.");
      }
      const access = await vault.encrypt(tokens.access_token, `connection:${row.id}:access`);
      const refresh = tokens.refresh_token ? await vault.encrypt(tokens.refresh_token, `connection:${row.id}:refresh`) : row.refresh_token;
      const updated = await db.prepare(`UPDATE oauth_connections SET access_token = ?, refresh_token = ?, expires_at = ?, version = version + 1,
        refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ? AND refresh_lease_until > ? RETURNING *`)
        .bind(access, refresh, Date.now() + tokens.expires_in * 1000, row.id, row.version, lease, Date.now()).first<ConnectionRow>();
      if (!updated) throw new OAuthError("Connection changed during refresh. Retry the token request.");
      return this.#token(updated, service);
    } catch (error) {
      if (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant") {
        await this.#invalidate(row, lease);
        throw new OAuthError("Google access has expired or was revoked. Reconnect the account.");
      }
      throw error;
    } finally {
      await db.prepare("UPDATE oauth_connections SET refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ?")
        .bind(row.id, row.version, lease).run();
    }
  }

  async #invalidate(row: ConnectionRow, lease: string) {
    await this.#env.DB.prepare(`UPDATE oauth_connections SET status = 'reconnect_required', access_token = NULL, refresh_token = NULL,
      version = version + 1, refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ?`)
      .bind(row.id, row.version, lease).run();
  }
}
