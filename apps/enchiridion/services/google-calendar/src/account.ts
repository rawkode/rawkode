import { DurableObject } from 'cloudflare:workers';
import { connectOAuth } from '@enchiridion/oauth-client';
import type { CalendarEnv } from './env';
import { syncGoogle } from './mirror';
import { watchMail } from './gmail';
import { scopes } from './google';

/** One coordinator per OAuth connection. D1 remains the source-record query store. */
export class GoogleAccount extends DurableObject<CalendarEnv> {
  async start(connectionId: string, immediate = false) {
    const existing = await this.ctx.storage.get<string>('connection');
    if (existing && existing !== connectionId) throw new Error('Account identity mismatch');
    await this.ctx.storage.put('connection', connectionId);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || immediate && alarm > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    const id = await this.ctx.storage.get<string>('connection');
    if (!id) return;
    // A recovery alarm is durable before network I/O, including unexpected termination.
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
    try {
      using oauth = await connectOAuth(this.env.OAUTH, this.env.OAUTH_SERVICE_CREDENTIAL);
      const connection = (await oauth.listConnections()).find(c => c.id === id && c.providerId === 'google' && c.status === 'connected');
      if (!connection) { await this.ctx.storage.deleteAlarm(); return; }
      const result = await syncGoogle(this.env, oauth, connection);
      if (this.env.GMAIL_PUBSUB_TOPIC && connection.scopes.includes(scopes.gmail)) {
        const watch = await this.env.DB.prepare('SELECT renewed_at FROM gmail_watches WHERE connection_id = ?').bind(id).first<{ renewed_at: number }>();
        if (watch && watch.renewed_at < Date.now() - 86_400_000) await watchMail(this.env, oauth, connection);
      }
      await this.ctx.storage.put('failures', 0);
      await this.ctx.storage.setAlarm(Date.now() + (result.pending ? 1000 : 15 * 60_000));
    } catch {
      const failures = Math.min((await this.ctx.storage.get<number>('failures') ?? 0) + 1, 10);
      await this.ctx.storage.put('failures', failures);
      await this.ctx.storage.setAlarm(Date.now() + Math.min(30_000 * 2 ** (failures - 1), 3_600_000));
      console.error('Google account sync will retry', { connectionId: id, failures });
    }
  }
}
