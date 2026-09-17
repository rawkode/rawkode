import * as oauth from "oauth4webapi";
import type { OAuthProvider } from "@enchiridion/oauth-client/contracts";
import type { OAuthEnv } from "./env";
import { websiteOrigin } from "./env";
import { OAuthError } from "./errors";

export const google: OAuthProvider = {
  id: "google", name: "Google", identityScopes: ["openid", "email"],
  presets: [
    { id: "google-workspace", name: "Google Workspace", description: "Sync contacts and calendars; search Gmail and receive mailbox notifications without mirroring email.", scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/gmail.readonly"] },
    { id: "google-contacts", name: "Google Contacts", description: "Sync saved contacts.", scopes: ["https://www.googleapis.com/auth/contacts.readonly"] },
    { id: "google-calendar", name: "Google Calendar", description: "Read calendar events.", scopes: ["https://www.googleapis.com/auth/calendar.readonly"] },
    { id: "google-mail", name: "Google Mail", description: "Read mail messages and labels.", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
    { id: "google-drive", name: "Google Drive", description: "Read files and their metadata.", scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
  ],
};

export function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope === "https://www.googleapis.com/auth/userinfo.email" ? "email"
    : scope === "https://www.googleapis.com/auth/userinfo.profile" ? "profile" : scope))].sort();
}

export function provider(id: string, env: OAuthEnv) {
  if (id !== google.id) throw new OAuthError("This OAuth provider is not supported.");
  const local = env.LOCAL_PROVIDER_ORIGIN;
  if (local) {
    const url = new URL(local);
    if (!websiteOrigin(env).startsWith("http:") || url.origin !== local || url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
      throw new Error("The test provider is available only with loopback development origins.");
    }
  }
  const server: oauth.AuthorizationServer = {
    issuer: local || "https://accounts.google.com",
    authorization_endpoint: local ? `${local}/authorize` : "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: local ? `${local}/token` : "https://oauth2.googleapis.com/token",
    userinfo_endpoint: local ? `${local}/userinfo` : "https://openidconnect.googleapis.com/v1/userinfo",
    jwks_uri: local ? `${local}/jwks` : "https://www.googleapis.com/oauth2/v3/certs",
  };
  const options = { signal: () => AbortSignal.timeout(10_000), [oauth.allowInsecureRequests]: Boolean(local) };
  return {
    definition: google,
    server,
    options,
    redirectUri: `${websiteOrigin(env)}/oauth/callback/google`,
    validateScopes(scopes: string[]) {
      if (scopes.some((scope) => !["openid", "email", "profile"].includes(scope) && !/^https:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9._/-]+$/.test(scope))) {
        throw new OAuthError("Enter valid Google OAuth scopes.");
      }
      return normalizeScopes([...google.identityScopes, ...scopes]);
    },
  };
}
