import type { Connection, OAuthIntegrationApi } from '@enchiridion/oauth-client';
import type { CalendarEnv } from './env';

export const scopes = {
  calendars: 'https://www.googleapis.com/auth/calendar.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
};

export function endpoint(env: CalendarEnv, path: string, people = false) {
  if (env.LOCAL_PROVIDER_ORIGIN) {
    const url = new URL(env.LOCAL_PROVIDER_ORIGIN);
    if (url.origin !== env.LOCAL_PROVIDER_ORIGIN || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Invalid local provider');
    return new URL(path, url);
  }
  return new URL(path, people ? 'https://people.googleapis.com' : 'https://www.googleapis.com');
}

export async function authorized(oauth: OAuthIntegrationApi, connection: Connection, scope: string) {
  const current = (await oauth.listConnections()).find(c => c.id === connection.id && c.ownerId === connection.ownerId && c.providerId === 'google' && c.status === 'connected' && c.scopes.includes(scope));
  if (!current) throw new Error('Google access is not authorized. Check the connection and permissions.');
}

export async function googleRequest(oauth: OAuthIntegrationApi, connection: Connection, scope: string, url: URL, init: RequestInit = {}) {
  await authorized(oauth, connection, scope);
  const token = await oauth.getAccessToken(connection.id, [scope]);
  return fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token.accessToken}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
}
