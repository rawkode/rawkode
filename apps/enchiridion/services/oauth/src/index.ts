import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import type { OAuthEnv } from "./env";
import { AdminApi } from "./admin";
import { callback } from "./callback";
import { authenticateService, IntegrationApi } from "./tokens";
import { safeCall } from "./errors";

/** Bind only trusted admin servers to this entrypoint. It is never publicly routed. */
export class OAuthAdmin extends WorkerEntrypoint<OAuthEnv> {
  admin(ownerId: string) { return new AdminApi(this.env, ownerId); }
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const owner = request.headers.get("X-Enchiridion-Owner");
    if (!owner) return new Response("Unauthorized", { status: 401 });
    return newWorkersRpcResponse(request, new AdminApi(this.env, owner));
  }
}

/** A binding plus a service-specific credential are required; grants are checked on every call. */
export class OAuthIntegrations extends WorkerEntrypoint<OAuthEnv> {
  async authorize(credential: string) {
    return safeCall(async () => { await authenticateService(this.env, credential); return new IntegrationApi(this.env, credential); });
  }
  async fetch(request: Request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const credential = request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
    try { await authenticateService(this.env, credential); }
    catch { return new Response("Unauthorized", { status: 401 }); }
    return newWorkersRpcResponse(request, new IntegrationApi(this.env, credential));
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ service: "oauth", status: "ok" });
    if (path === "/oauth/callback/google" && request.method === "GET") {
      try { return await callback(request, env); }
      catch { return new Response("The connection could not be completed. Start again from the admin interface.", { status: 500, headers: { "Cache-Control": "no-store" } }); }
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM oauth_sessions WHERE expires_at <= ?").bind(Date.now()).run();
  },
} satisfies ExportedHandler<OAuthEnv>;
