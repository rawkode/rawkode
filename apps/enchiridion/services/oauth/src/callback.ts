import * as oauth from "oauth4webapi";
import type { OAuthEnv } from "./env";
import { websiteOrigin } from "./env";
import { sha256, TokenVault } from "./crypto";
import { normalizeScopes, provider } from "./providers";
import type { AppRow, ConnectionRow, SessionRow } from "./store";

export function bindingCookieName(stateId: string, secure: boolean): string {
  return `${secure ? "__Host-" : ""}enchiridion-oauth-${stateId.slice(0,24)}`;
}

export async function callback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const origin = websiteOrigin(env);
  const state = url.searchParams.get("state");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || url.searchParams.getAll("state").length !== 1) {
    return new Response("Invalid OAuth state. Start again from the admin interface.", { status: 400 });
  }
  const stateId = await sha256(state);
  const secure = origin.startsWith("https:");
  const cookieName = bindingCookieName(stateId, secure);
  const cookies = (request.headers.get("Cookie") || "").split(";").map((v) => v.trim());
  const matches = cookies.filter((cookie) => cookie.startsWith(`${cookieName}=`));
  const binding = matches.length === 1 ? matches[0].slice(cookieName.length + 1) : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) return new Response("This connection was started in another browser, or has expired.", { status: 400 });
  const browserHash = await sha256(binding);
  // Atomic consume only after verifying browser, expiry, and provider route. Replays never reach Google.
  const session = await env.DB.prepare(`DELETE FROM oauth_sessions WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
    AND app_id IN (SELECT id FROM oauth_apps WHERE provider_id = ?) RETURNING *`)
    .bind(stateId, browserHash, Date.now(), url.pathname.split("/").at(-1)).first<SessionRow>();
  if (!session) return new Response("This connection has expired or was already completed. Start again.", { status: 400 });

  let result = "failed";
  try {
    const app = await env.DB.prepare("SELECT * FROM oauth_apps WHERE id = ?").bind(session.app_id).first<AppRow>();
    if (!app) throw new Error("App missing.");
    const p = provider(app.provider_id, env);
    const vault = new TokenVault(env);
    const client: oauth.Client = { client_id: app.client_id };
    const parameters = oauth.validateAuthResponse(p.server, client, url, state);
    const response = await oauth.authorizationCodeGrantRequest(p.server, client,
      oauth.ClientSecretPost(await vault.decrypt(app.client_secret, `app:${app.id}:secret`)), parameters,
      p.redirectUri, await vault.decrypt(session.verifier, `session:${stateId}`), p.options);
    const tokens = await oauth.processAuthorizationCodeResponse(p.server, client, response, { expectedNonce: session.nonce, requireIdToken: true });
    const claims = oauth.getValidatedIdTokenClaims(tokens)!;
    const userResponse = await oauth.userInfoRequest(p.server, client, tokens.access_token, p.options);
    const user = await oauth.processUserInfoResponse(p.server, client, claims.sub, userResponse);
    const scopes = normalizeScopes(tokens.scope?.split(" ").filter(Boolean) ?? JSON.parse(app.scopes));
    if (JSON.stringify(scopes) !== app.scopes || tokens.token_type !== "bearer" || !tokens.expires_in || tokens.expires_in <= 0) {
      result = "scopes";
      throw new Error("Unexpected token permissions or lifetime.");
    }
    const old = await env.DB.prepare("SELECT * FROM oauth_connections WHERE app_id = ? AND owner_id = ? AND account_id = ?")
      .bind(app.id, session.owner_id, claims.sub).first<ConnectionRow>();
    if (!tokens.refresh_token && !old?.refresh_token) { result = "offline"; throw new Error("Offline access required."); }
    const id = old?.id ?? crypto.randomUUID();
    const access = await vault.encrypt(tokens.access_token, `connection:${id}:access`);
    const refresh = tokens.refresh_token ? await vault.encrypt(tokens.refresh_token, `connection:${id}:refresh`) : old!.refresh_token;
    const label = typeof user.email === "string" && user.email_verified === true ? user.email : claims.sub;
    const expires = Date.now() + tokens.expires_in * 1000;
    if (old) {
      const update = await env.DB.prepare(`UPDATE oauth_connections SET account_label = ?, scopes = ?, access_token = ?, refresh_token = ?, expires_at = ?,
        status = 'connected', version = version + 1, refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ?`)
        .bind(label, JSON.stringify(scopes), access, refresh, expires, id, old.version).run();
      if (update.meta.changes !== 1) throw new Error("Connection changed during authorization.");
    } else {
      await env.DB.prepare(`INSERT INTO oauth_connections (id, app_id, owner_id, account_id, account_label, scopes, access_token, refresh_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, app.id, session.owner_id, claims.sub, label, JSON.stringify(scopes), access, refresh, expires, Date.now()).run();
    }
    result = "connected";
  } catch {
    if (url.searchParams.get("error") === "access_denied") result = "cancelled";
    // Never expose provider errors, authorization codes, tokens, or client secrets.
  }
  return new Response(null, { status: 303, headers: {
    Location: `${origin}/admin/oauth?result=${result}`,
    "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
