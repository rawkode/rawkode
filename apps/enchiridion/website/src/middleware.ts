import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { authenticate, sameOriginPost } from "./lib/auth";

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const protectedRoute = path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/");
  if (protectedRoute) {
    const admin = await authenticate(context.request, env, import.meta.env.DEV);
    if (!admin) return new Response("Admin access is required. Configure Cloudflare Access, or run the local setup with Bun.", { status: 401, headers: { "Cache-Control": "no-store" } });
    context.locals.admin = admin;
    if (!["GET", "HEAD"].includes(context.request.method) && !sameOriginPost(context.request, env.WEBSITE_ORIGIN)) {
      return new Response("Request origin is not allowed.", { status: 403 });
    }
  }
  const upstream = await next();
  const response = new Response(upstream.body, upstream);
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Same-origin form POSTs need an Origin header for CSRF checks. Suppress all
  // referrers only on callbacks, where the URL contains an authorization code.
  response.headers.set("Referrer-Policy", path.startsWith("/oauth/") ? "no-referrer" : "same-origin");
  response.headers.set("X-Frame-Options", "DENY");
  if (protectedRoute || path.startsWith("/oauth/")) response.headers.set("Cache-Control", "no-store");
  if (!import.meta.env.DEV) response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return response;
});
