import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import type {
	GitHubActivityApi,
	GitHubApi,
	RepositoryQuery,
} from "@e2/oauth-client/github";
import { createGitHubApi } from "./api.ts";
import type { GitHubEnv } from "./env.ts";

// Prototype methods are required by Cloudflare RPC; implementation stays functional.
export class GitHubAdminApi extends RpcTarget
	implements GitHubApi, GitHubActivityApi {
	readonly #api: GitHubApi & GitHubActivityApi;
	constructor(env: GitHubEnv, ownerId: string) {
		super();
		this.#api = createGitHubApi(env, ownerId);
	}
	listConnections() {
		return this.#api.listConnections();
	}
	getProfile(connectionId: string) {
		return this.#api.getProfile(connectionId);
	}
	listRepositories(connectionId: string, page?: number) {
		return this.#api.listRepositories(connectionId, page);
	}
	listIssues(connectionId: string, query: RepositoryQuery) {
		return this.#api.listIssues(connectionId, query);
	}
	listPullRequests(connectionId: string, query: RepositoryQuery) {
		return this.#api.listPullRequests(connectionId, query);
	}
	listActivity(connectionId: string, page?: number) {
		return this.#api.listActivity(connectionId, page);
	}
}

/** Bind trusted admin servers only; never route this entrypoint publicly. */
export class GitHubAdmin extends WorkerEntrypoint<GitHubEnv> {
	admin(ownerId: string) {
		return new GitHubAdminApi(this.env, ownerId);
	}
	override fetch(request: Request) {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		const owner = request.headers.get("X-E2-Owner");
		if (!owner) return new Response("Unauthorized", { status: 401 });
		return newWorkersRpcResponse(request, this.admin(owner));
	}
}

export default {
	fetch: (request: Request) =>
		new URL(request.url).pathname === "/health" && request.method === "GET"
			? Response.json({ service: "integrations-github", status: "ok" })
			: new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<GitHubEnv>;
