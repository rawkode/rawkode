import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const GET: APIRoute = async ({ request, params }) => {
  if (params.provider !== "google") return new Response("Provider not found", { status: 404 });
  const query = new URL(request.url).search;
  return env.OAUTH_CALLBACK.fetch(new Request(`https://oauth.internal/oauth/callback/google${query}`, {
    headers: { Cookie: request.headers.get("Cookie") || "" }, redirect: "manual",
  }));
};
