import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

/** Authenticated readiness check for the complete service-binding chain. */
export const GET: APIRoute = async ({ locals }) => {
  try {
    using oauth = await env.OAUTH_ADMIN.admin(locals.admin!.ownerId);
    using calendar = await env.CALENDAR_ADMIN.admin(locals.admin!.ownerId);
    using documents = await env.DOCUMENTS.forOwner(locals.admin!.ownerId);
    await Promise.all([oauth.listApps(), calendar.listConnections(), documents.load('health')]);
    return Response.json({ status: "ok", services: ["website", "oauth", "google-calendar", "documents"] });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
};
