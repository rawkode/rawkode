import type { Connection, OAuthIntegrationApi } from '@enchiridion/oauth-client';
import type { CalendarEnv } from './env';
import { authorized, endpoint, googleRequest, scopes } from './google';

type RecordData = { id?: string; resourceName?: string; status?: string; deleted?: boolean; metadata?: { deleted?: boolean }; accessRole?: string; [key: string]: unknown };
interface Cursor { sync_token: string | null; page_token: string | null; generation: string }

/** One page per invocation: durable staging and page cursors bound each Worker execution. */
export async function syncCollection(env: CalendarEnv, oauth: OAuthIntegrationApi, connection: Connection, collection: string) {
  const contacts = collection === 'contacts';
  const scope = contacts ? scopes.contacts : scopes.calendars;
  await authorized(oauth, connection, scope);
  const db = env.DB, id = connection.id, lease = crypto.randomUUID();
  await db.prepare('INSERT OR IGNORE INTO google_syncs(connection_id, collection, owner_id, generation) VALUES (?, ?, ?, ?)').bind(id, collection, connection.ownerId, crypto.randomUUID()).run();
  const cursor = await db.prepare('UPDATE google_syncs SET lease = ?, lease_until = ? WHERE connection_id = ? AND collection = ? AND owner_id = ? AND (lease_until IS NULL OR lease_until < ?) RETURNING sync_token, page_token, generation')
    .bind(lease, Date.now() + 60_000, id, collection, connection.ownerId, Date.now()).first<Cursor>();
  if (!cursor) return { changed: 0, pending: true };
  const gate = 'EXISTS (SELECT 1 FROM google_syncs WHERE connection_id = ? AND collection = ? AND lease = ? AND lease_until > ?)';
  try {
    const path = contacts ? '/v1/people/me/connections' : collection === 'calendars' ? '/calendar/v3/users/me/calendarList' : `/calendar/v3/calendars/${encodeURIComponent(collection.slice(7))}/events`;
    const url = endpoint(env, path, contacts);
    if (contacts) {
      url.searchParams.set('personFields', 'names,emailAddresses,phoneNumbers,organizations,photos,addresses,birthdays,urls,metadata');
      url.searchParams.set('requestSyncToken', 'true');
      url.searchParams.set('pageSize', '100');
    } else {
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('showDeleted', 'true');
      if (collection === 'calendars') url.searchParams.set('showHidden', 'true');
      else url.searchParams.set('singleEvents', 'false');
    }
    if (cursor.sync_token) url.searchParams.set('syncToken', cursor.sync_token);
    if (cursor.page_token) url.searchParams.set('pageToken', cursor.page_token);
    const response = await googleRequest(oauth, connection, scope, url);
    const body = await response.json() as { items?: RecordData[]; connections?: RecordData[]; nextPageToken?: string; nextSyncToken?: string; error?: { details?: { reason?: string }[] } };
    if (cursor.sync_token && (response.status === 410 || body.error?.details?.some(d => d.reason === 'EXPIRED_SYNC_TOKEN'))) {
      await db.batch([
        db.prepare(`DELETE FROM google_staging WHERE generation = ? AND ${gate}`).bind(cursor.generation, id, collection, lease, Date.now()),
        db.prepare('UPDATE google_syncs SET sync_token = NULL, page_token = NULL, generation = ? WHERE connection_id = ? AND collection = ? AND lease = ?').bind(crypto.randomUUID(), id, collection, lease),
      ]);
      return { changed: 0, pending: true };
    }
    if (!response.ok) throw new Error('Google sync failed. Retry after checking account permissions or quota.');
    const records = (contacts ? body.connections : body.items) ?? [];
    if (!Array.isArray(records)) throw new Error('Invalid Google page');
    const now = Date.now();
    const statements = records.map(record => {
      const key = contacts ? record.resourceName : record.id;
      if (!record || typeof key !== 'string' || !key || key.length > 2048) throw new Error('Invalid Google resource');
      return db.prepare(`INSERT OR REPLACE INTO google_staging(generation, resource_id, data, deleted) SELECT ?, ?, ?, ? WHERE ${gate}`)
        .bind(cursor.generation, key, JSON.stringify(record), record.deleted || record.metadata?.deleted || record.status === 'cancelled' ? 1 : 0, id, collection, lease, now);
    });
    await authorized(oauth, connection, scope);
    if (body.nextPageToken) {
      if (typeof body.nextPageToken !== 'string' || body.nextPageToken === cursor.page_token) throw new Error('Invalid Google page cursor');
      statements.push(db.prepare('UPDATE google_syncs SET page_token = ? WHERE connection_id = ? AND collection = ? AND lease = ? AND lease_until > ?').bind(body.nextPageToken, id, collection, lease, now));
    } else {
      if (typeof body.nextSyncToken !== 'string' || !body.nextSyncToken) throw new Error('Missing Google sync cursor');
      // Tombstones preserve stable references for the future entity layer.
      if (!cursor.sync_token) statements.push(db.prepare(`UPDATE google_records SET deleted = 1 WHERE connection_id = ? AND collection = ? AND ${gate}`).bind(id, collection, id, collection, lease, now));
      statements.push(db.prepare(`INSERT INTO google_records(connection_id, collection, resource_id, data, deleted) SELECT ?, ?, resource_id, data, deleted FROM google_staging WHERE generation = ? AND ${gate} ON CONFLICT(connection_id, collection, resource_id) DO UPDATE SET data = excluded.data, deleted = excluded.deleted`).bind(id, collection, cursor.generation, id, collection, lease, now));
      statements.push(db.prepare(`DELETE FROM google_staging WHERE generation = ? AND ${gate}`).bind(cursor.generation, id, collection, lease, now));
      statements.push(db.prepare('UPDATE google_syncs SET sync_token = ?, page_token = NULL, synced_at = ?, generation = ? WHERE connection_id = ? AND collection = ? AND lease = ? AND lease_until > ?').bind(body.nextSyncToken, now, crypto.randomUUID(), id, collection, lease, now));
    }
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new Error('Google sync lease expired; retry.');
    return { changed: records.length, pending: Boolean(body.nextPageToken) };
  } finally {
    await db.prepare('UPDATE google_syncs SET lease = NULL, lease_until = NULL WHERE connection_id = ? AND collection = ? AND lease = ?').bind(id, collection, lease).run();
  }
}

export async function syncGoogle(env: CalendarEnv, oauth: OAuthIntegrationApi, connection: Connection) {
  let changed = 0, pending = false;
  const collections: string[] = [];
  if (connection.scopes.includes(scopes.contacts)) collections.push('contacts');
  if (connection.scopes.includes(scopes.calendars)) collections.push('calendars');
  for (const collection of collections) {
    const result = await syncCollection(env, oauth, connection, collection);
    changed += result.changed; pending ||= result.pending;
  }
  if (connection.scopes.includes(scopes.calendars)) {
    const { results } = await env.DB.prepare("SELECT resource_id FROM google_records WHERE connection_id = ? AND collection = 'calendars' AND deleted = 0 AND json_extract(data, '$.accessRole') IN ('reader','writer','owner') ORDER BY resource_id").bind(connection.id).all<{ resource_id: string }>();
    // Fair scheduling: oldest collections first, at most ten calendars per invocation.
    const cursors = await env.DB.prepare("SELECT collection, synced_at FROM google_syncs WHERE connection_id = ?").bind(connection.id).all<{ collection: string; synced_at: number | null }>();
    const times = new Map(cursors.results.map(c => [c.collection, c.synced_at ?? 0]));
    const ordered = results.sort((a, b) => (times.get(`events:${a.resource_id}`) ?? 0) - (times.get(`events:${b.resource_id}`) ?? 0));
    for (const calendar of ordered.slice(0, 10)) {
      const result = await syncCollection(env, oauth, connection, `events:${calendar.resource_id}`);
      changed += result.changed; pending ||= result.pending;
    }
    pending ||= ordered.slice(10).some(c => !times.get(`events:${c.resource_id}`));
  }
  return { changed, pending, syncedAt: Date.now() };
}
