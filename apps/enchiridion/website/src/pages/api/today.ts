import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import type { CalendarApi } from '@enchiridion/oauth-client/calendar';
export const GET: APIRoute = async ({ locals, url }) => {
  const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 2 * 86400000) return new Response('Invalid day', { status: 400 });
  try {
    using api = await env.CALENDAR_ADMIN.admin(locals.admin!.ownerId);
    const all = await api.listConnections();
    const connections = all.filter(c => c.scopes.includes('https://www.googleapis.com/auth/calendar.readonly'));
    const events: Awaited<ReturnType<CalendarApi['upcoming']>>['events'] = [];
    let partial = connections.length > 3;
    for (const connection of connections.slice(0, 3)) {
      try { const result = await api.upcoming(connection.id, from, to); events.push(...result.events); partial ||= result.partial; }
      catch { partial = true; }
    }
    const mailConnections = all.filter(c => c.scopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
    const mailPeople: { email: string; name: string }[] = []; let mailPartial = mailConnections.length > 1;
    for (const connection of mailConnections.slice(0, 1)) {
      try { const result = await api.mailPeople(connection.id, from, to); mailPeople.push(...result.people); mailPartial ||= result.partial; }
      catch { mailPartial = true; }
    }
    return Response.json({ events, partial, connected: connections.length > 0, mailPeople, mailPartial });
  } catch { return Response.json({ error: 'Calendar context unavailable' }, { status: 503 }); }
};
