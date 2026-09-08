import { RpcTarget } from "capnweb";
import * as oauth from "oauth4webapi";
import type { CreateAppInput, OAuthAdminApi } from "@enchiridion/oauth-client/contracts";
import type { OAuthEnv } from "./env";
import { serviceCredentials, websiteOrigin } from "./env";
import { TokenVault, randomSecret, sha256 } from "./crypto";
import { OAuthError, requireScopes, requireString, safeCall } from "./errors";
import { google, provider } from "./providers";
import { listConnections, publicApp, type AppRow } from "./store";

export class AdminApi extends RpcTarget implements OAuthAdminApi {
  #env: OAuthEnv;
  #owner: string;
  constructor(env: OAuthEnv, owner: string) { super(); this.#env = env; this.#owner = requireString(owner, "account identity", 200); }

  getConfiguration() {
    return safeCall(async () => ({ providers: [google], serviceIds: Object.keys(serviceCredentials(this.#env)).sort(), redirectOrigin: websiteOrigin(this.#env) }));
  }

  listApps() {
    return safeCall(async () => {
      const { results } = await this.#env.DB.prepare("SELECT * FROM oauth_apps ORDER BY created_at DESC, id").all<AppRow>();
      return results.map((row) => publicApp(row, this.#env));
    });
  }

  createApp(input: CreateAppInput) {
    return safeCall(async () => {
      if (!input || typeof input !== "object") throw new OAuthError("Enter the OAuth app details.");
      const name = requireString(input.name, "app name", 100);
      const p = provider(requireString(input.providerId, "provider"), this.#env);
      const clientId = requireString(input.clientId, "client ID", 500);
      const secret = requireString(input.clientSecret, "client secret", 4096);
      const scopes = p.validateScopes(requireScopes(input.scopes));
      const id = crypto.randomUUID();
      const row: AppRow = { id, name, provider_id: p.definition.id, client_id: clientId,
        client_secret: await new TokenVault(this.#env).encrypt(secret, `app:${id}:secret`), scopes: JSON.stringify(scopes), created_at: Date.now() };
      await this.#env.DB.prepare("INSERT INTO oauth_apps (id, name, provider_id, client_id, client_secret, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.name, row.provider_id, row.client_id, row.client_secret, row.scopes, row.created_at).run();
      return publicApp(row, this.#env);
    });
  }

  listConnections() { return safeCall(() => listConnections(this.#env.DB, { ownerId: this.#owner })); }

  beginConnection(input: { appId: string; browserBindingHash: string }) {
    return safeCall(async () => {
      if (!input || !/^[a-f0-9]{64}$/.test(input.browserBindingHash)) throw new OAuthError("Invalid browser binding.");
      const app = await this.#env.DB.prepare("SELECT * FROM oauth_apps WHERE id = ?").bind(requireString(input.appId, "app ID")).first<AppRow>();
      if (!app) throw new OAuthError("OAuth app not found.");
      const p = provider(app.provider_id, this.#env);
      const state = randomSecret();
      const stateId = await sha256(state);
      const verifier = oauth.generateRandomCodeVerifier();
      const nonce = oauth.generateRandomNonce();
      const url = new URL(p.server.authorization_endpoint!);
      url.search = new URLSearchParams({ client_id: app.client_id, redirect_uri: p.redirectUri, response_type: "code",
        scope: JSON.parse(app.scopes).join(" "), state, nonce, code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256", access_type: "offline", prompt: "consent" }).toString();
      await this.#env.DB.prepare("INSERT INTO oauth_sessions (state_hash, app_id, owner_id, browser_binding_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(stateId, app.id, this.#owner, input.browserBindingHash, await new TokenVault(this.#env).encrypt(verifier, `session:${stateId}`), nonce, Date.now() + 600_000).run();
      return { authorizationUrl: url.toString(), stateId };
    });
  }

  async #owns(id: string) {
    const row = await this.#env.DB.prepare("SELECT id FROM oauth_connections WHERE id = ? AND owner_id = ?").bind(requireString(id, "connection ID"), this.#owner).first();
    if (!row) throw new OAuthError("Connection not found.");
  }

  disconnect(connectionId: string) {
    return safeCall(async () => {
      await this.#owns(connectionId);
      // Deleting the row invalidates in-flight refresh writes and cascades all consumer grants.
      await this.#env.DB.prepare("DELETE FROM oauth_connections WHERE id = ? AND owner_id = ?").bind(connectionId, this.#owner).run();
    });
  }

  grantService(connectionId: string, serviceId: string) {
    return safeCall(async () => {
      await this.#owns(connectionId);
      if (!Object.hasOwn(serviceCredentials(this.#env), serviceId)) throw new OAuthError("Integration service not configured.");
      await this.#env.DB.prepare("INSERT OR IGNORE INTO oauth_service_grants (connection_id, service_id, created_at) SELECT id, ?, ? FROM oauth_connections WHERE id = ? AND owner_id = ?")
        .bind(serviceId, Date.now(), connectionId, this.#owner).run();
    });
  }

  revokeService(connectionId: string, serviceId: string) {
    return safeCall(async () => {
      await this.#owns(connectionId);
      await this.#env.DB.prepare("DELETE FROM oauth_service_grants WHERE connection_id = ? AND service_id = ?").bind(connectionId, requireString(serviceId, "service ID")).run();
    });
  }
}
