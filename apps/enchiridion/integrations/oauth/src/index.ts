import { WorkerEntrypoint } from "cloudflare:workers";
import type { OAuthEnv } from "./env.ts";
import { AdminApi } from "./admin.ts";
import { callback } from "./callback.ts";
import {
	adminResponse,
	authorizeIntegration,
	integrationResponse,
} from "./transport.ts";

/** Bind only trusted admin servers to this entrypoint. It is never publicly routed. */
export class OAuthAdmin extends WorkerEntrypoint<OAuthEnv> {
	admin(ownerId: string) {
		return new AdminApi(this.env, ownerId);
	}
	override fetch(request: Request) {
		return adminResponse(request, this.env);
	}
}

/** A binding plus a service-specific credential are required; grants are checked on every call. */
export class OAuthIntegrations extends WorkerEntrypoint<OAuthEnv> {
	authorize(credential: string) {
		return authorizeIntegration(this.env, credential);
	}
	override fetch(request: Request) {
		return integrationResponse(request, this.env);
	}
}

export default {
	fetch: async (request, env) => {
		const path = new URL(request.url).pathname;
		if (path === "/health" && request.method === "GET") {
			return Response.json({ service: "integrations-oauth", status: "ok" });
		}
		if (
			["/oauth/callback/google", "/oauth/callback/github"].includes(path) &&
			request.method === "GET"
		) {
			try {
				return await callback(request, env);
			} catch {
				return new Response(
					"The connection could not be completed. Start again from the admin interface.",
					{ status: 500, headers: { "Cache-Control": "no-store" } },
				);
			}
		}
		return new Response("Not found", { status: 404 });
	},
	scheduled: async (_event, env) => {
		await env.DB.prepare("DELETE FROM oauth_sessions WHERE expires_at <= ?")
			.bind(Date.now()).run();
	},
} satisfies ExportedHandler<OAuthEnv>;
