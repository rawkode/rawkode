import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// The session is created only after middleware authentication and same-origin checks.
export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.admin) return new Response('Unauthorized', { status: 401 });
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing body', { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 2_100_000) { await reader.cancel(); return new Response('Document request too large', { status: 413 }); }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return env.DOCUMENTS.fetch(new Request('https://documents.internal/rpc', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Enchiridion-Owner': locals.admin.ownerId }, body }));
};
