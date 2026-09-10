import { WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import type {
	GitHubActivityApi,
	GitHubApi,
	RepositoryQuery,
} from "@e2/oauth-client/github";
import { createGitHubApi } from "./api.ts";
import type { GitHubEnv } from "./env.ts";
import {
	assertReadOnlyPermissions,
	githubAppConfigured,
	readGitHubInstallation,
	verifyGitHubWebhook,
} from "./app-auth.ts";
import {
	activeInstallationIds,
	beginInstallation,
	claimInstallation,
	deleteExpiredSetupSessions,
	installationOwner,
	listInstallations,
	setInstallationStatus,
	touchInstallation,
} from "./registry.ts";
export { GitHubInstallation } from "./installation.ts";

// Prototype methods are required by Cloudflare RPC; implementation stays functional.
export class GitHubAdminApi extends RpcTarget
	implements GitHubApi, GitHubActivityApi {
	readonly #api: GitHubApi & GitHubActivityApi;
	readonly #env: GitHubEnv;
	readonly #ownerId: string;
	constructor(env: GitHubEnv, ownerId: string) {
		super();
		this.#env = env;
		this.#ownerId = ownerId;
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
	async beginAppInstallation() {
		if (!githubAppConfigured(this.#env) || !this.#env.GITHUB_APP_SLUG) {
			throw new Error("GitHub App is not configured");
		}
		const state = await beginInstallation(this.#env.DB, this.#ownerId);
		return {
			state,
			url: `https://github.com/apps/${
				encodeURIComponent(this.#env.GITHUB_APP_SLUG)
			}/installations/new?state=${state}`,
		};
	}
	async completeAppInstallation(state: string, installationId: string) {
		if (!githubAppConfigured(this.#env)) {
			throw new Error("GitHub App is not configured");
		}
		const installation = await readGitHubInstallation(
			this.#env,
			installationId,
		);
		if (String(installation.id) !== installationId) {
			throw new Error("GitHub installation identity mismatch");
		}
		assertReadOnlyPermissions(installation.permissions);
		const account = installation.account;
		if (!account || typeof account !== "object" || Array.isArray(account)) {
			throw new Error("GitHub installation account is unavailable");
		}
		const row = account as Record<string, unknown>;
		const targetType = installation.target_type;
		if (targetType !== "User" && targetType !== "Organization") {
			throw new Error("GitHub installation target is invalid");
		}
		const identity = await claimInstallation(this.#env.DB, state, {
			installationId: String(installation.id),
			accountId: String(row.id),
			accountLogin: String(row.login),
			targetType,
		});
		await this.#env.GITHUB_INSTALLATIONS.getByName(identity.installationId)
			.claim(identity);
		return identity;
	}
	listAppInstallations() {
		if (!this.#env.DB) return Promise.resolve([]);
		return listInstallations(this.#env.DB, this.#ownerId);
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
	fetch: async (request: Request, env: GitHubEnv) => {
		const path = new URL(request.url).pathname;
		if (path === "/health" && request.method === "GET") {
			return Response.json({ service: "integrations-github", status: "ok" });
		}
		if (path !== "/github/webhook") {
			return new Response("Not found", { status: 404 });
		}
		if (!githubAppConfigured(env)) {
			return new Response("GitHub App is not configured", { status: 503 });
		}
		try {
			const verified = await verifyGitHubWebhook(
				request,
				await env.GITHUB_WEBHOOK_SECRET.get(),
			);
			const installation = verified.payload.installation;
			const id = installation && typeof installation === "object" &&
					!Array.isArray(installation)
				? String((installation as Record<string, unknown>).id)
				: "";
			if (!id) return new Response("Accepted", { status: 202 });
			const owner = await installationOwner(env.DB, id);
			if (!owner) return new Response("Accepted", { status: 202 });
			const result = await env.GITHUB_INSTALLATIONS.getByName(id)
				.receiveWebhook(
					verified.deliveryId,
					verified.event,
					verified.payload,
				);
			if (verified.event === "installation") {
				const action = String(verified.payload.action ?? "");
				if (["deleted", "suspend", "unsuspend"].includes(action)) {
					await setInstallationStatus(
						env.DB,
						id,
						action === "suspend"
							? "suspended"
							: action === "unsuspend"
							? "active"
							: "deleted",
					);
				}
			}
			return Response.json(result, { status: result.duplicate ? 200 : 202 });
		} catch {
			return new Response("Invalid GitHub webhook", { status: 401 });
		}
	},
	scheduled: async (_event, env) => {
		if (!githubAppConfigured(env)) return;
		await deleteExpiredSetupSessions(env.DB);
		for (const id of await activeInstallationIds(env.DB)) {
			try {
				await env.GITHUB_INSTALLATIONS.getByName(id).start();
			} catch {
				console.error("GitHub installation wake-up failed", {
					installationId: id,
				});
			} finally {
				await touchInstallation(env.DB, id);
			}
		}
	},
} satisfies ExportedHandler<GitHubEnv>;
