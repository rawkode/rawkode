import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { proxyRpc } from "../../../lib/rpc-proxy";
export const POST: APIRoute = ({ request, locals }) => proxyRpc(request, env.CALENDAR_ADMIN, locals.admin!.ownerId);
