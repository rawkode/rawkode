export interface OAuthEnv {
  DB: D1Database;
  WEBSITE_ORIGIN: string;
  /** JSON object of key IDs to base64-encoded, 32-byte AES keys. */
  TOKEN_ENCRYPTION_KEYS: string;
  TOKEN_ENCRYPTION_KEY_ID: string;
  /** JSON object of integration service IDs to SHA-256 hashes of bearer credentials. */
  SERVICE_CREDENTIALS?: string;
  /** Test-only, accepted exclusively with HTTP loopback origins. */
  LOCAL_PROVIDER_ORIGIN?: string;
}

export function websiteOrigin(env: OAuthEnv): string {
  const url = new URL(env.WEBSITE_ORIGIN);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.origin !== env.WEBSITE_ORIGIN) {
    throw new Error("WEBSITE_ORIGIN must be an HTTPS origin (HTTP loopback is allowed locally).");
  }
  return url.origin;
}

export function serviceCredentials(env: OAuthEnv): Record<string, string> {
  const value: unknown = JSON.parse(env.SERVICE_CREDENTIALS || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid service credentials configuration.");
  for (const [id, hash] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid service credentials configuration.");
    }
  }
  return value as Record<string, string>;
}
