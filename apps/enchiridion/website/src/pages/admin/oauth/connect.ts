import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const POST: APIRoute = async ({ request, locals, cookies, redirect }) => {
  if (Number(request.headers.get("Content-Length")) > 2048) return new Response("Request too large", { status: 413 });
  const body = await request.text();
  if (body.length > 2048) return new Response("Request too large", { status: 413 });
  const appId = new URLSearchParams(body).get("appId");
  if (!appId || appId.length > 100) return new Response("Select an OAuth app.", { status: 400 });
  const binding = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)));
  const browserBindingHash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    using api = await env.OAUTH_ADMIN.admin(locals.admin!.ownerId);
    const flow = await api.beginConnection({ appId, browserBindingHash });
    const secure = env.WEBSITE_ORIGIN.startsWith("https:");
    cookies.set(`${secure ? "__Host-" : ""}enchiridion-oauth-${flow.stateId.slice(0, 24)}`, binding, { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: 600 });
    return redirect(flow.authorizationUrl, 303);
  } catch { return redirect("/admin/oauth?result=failed", 303); }
};
