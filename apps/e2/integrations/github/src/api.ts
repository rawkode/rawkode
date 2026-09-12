import { connectOAuth } from "@e2/oauth-client";
import type {
	GitHubActivityApi,
	GitHubApi,
	GitHubPage,
	GitHubRecord,
	RepositoryQuery,
} from "@e2/oauth-client/github";
import type { GitHubEnv } from "./env.ts";

const apiOrigin = "https://api.github.com";
const pageSize = 50;
const githubIdentityScopes = ["read:user"];

const pageNumber = (value = 1): number => {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
		throw new Error("Page must be an integer between 1 and 1000.");
	}
	return value;
};

const repositoryPath = (query: RepositoryQuery): string => {
	if (
		!query || typeof query !== "object" ||
		typeof query.owner !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(query.owner) ||
		typeof query.repository !== "string" ||
		!/^[a-zA-Z0-9_.-]{1,100}$/.test(query.repository) ||
		[".", ".."].includes(query.repository)
	) {
		throw new Error("Select a valid GitHub repository.");
	}
	return `/repos/${encodeURIComponent(query.owner)}/${
		encodeURIComponent(query.repository)
	}`;
};

const record = (value: unknown): value is GitHubRecord =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Only private service bindings expose this owner-scoped API. */
export const createGitHubApi = (
	env: GitHubEnv,
	ownerId: string,
): GitHubApi & GitHubActivityApi => {
	if (typeof ownerId !== "string" || !ownerId || ownerId.length > 200) {
		throw new Error("Unauthorized.");
	}

	const listConnections = async () => {
		using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
		return (await oauth.listConnections()).filter((connection) =>
			connection.ownerId === ownerId && connection.providerId === "github" &&
			connection.status === "connected"
		);
	};

	const request = async (
		connectionId: string,
		path: string,
		params: Record<string, string> = {},
	) => {
		if (
			typeof connectionId !== "string" ||
			!(await listConnections()).some((connection) =>
				connection.id === connectionId
			)
		) {
			throw new Error("This GitHub connection is not authorized.");
		}
		using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
		const token = await oauth.getAccessToken(
			connectionId,
			githubIdentityScopes,
		);
		const url = new URL(path, apiOrigin);
		Object.entries(params).forEach(([key, value]) =>
			url.searchParams.set(key, value)
		);
		const response = await fetch(url, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token.accessToken}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "e2-integrations-github",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		}).catch(() => {
			throw new Error("GitHub is unavailable. Try again later.");
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 401) {
				throw new Error("Reconnect this GitHub account.");
			}
			if (response.status === 403 || response.status === 429) {
				throw new Error(
					"GitHub denied this request or its rate limit was reached.",
				);
			}
			if (response.status === 404) {
				throw new Error(
					"The repository is unavailable to this GitHub account.",
				);
			}
			throw new Error("GitHub is unavailable. Try again later.");
		}
		const body: unknown = await response.json();
		// Recheck the grant after network I/O so revoked requests do not publish data.
		await oauth.getAccessToken(connectionId, githubIdentityScopes);
		return {
			body,
			hasNext: /<[^>]+>;\s*rel="next"/.test(response.headers.get("Link") ?? ""),
		};
	};

	const list = async (
		connectionId: string,
		path: string,
		page = 1,
		params: Record<string, string> = {},
	): Promise<GitHubPage> => {
		const currentPage = pageNumber(page);
		const { body, hasNext } = await request(connectionId, path, {
			...params,
			per_page: String(pageSize),
			page: String(currentPage),
		});
		if (!Array.isArray(body) || body.length > pageSize || !body.every(record)) {
			throw new Error("GitHub returned an invalid response.");
		}
		return {
			items: body,
			nextPage: hasNext && currentPage < 1000 ? currentPage + 1 : null,
		};
	};

	const repositoryItems = (
		connectionId: string,
		query: RepositoryQuery,
		resource: "issues" | "pulls",
	) => {
		const path = repositoryPath(query);
		const state = query.state ?? "open";
		if (!["open", "closed", "all"].includes(state)) {
			throw new Error("Invalid issue state.");
		}
		return list(connectionId, `${path}/${resource}`, query.page, { state });
	};

	return {
		listConnections,
		getProfile: async (connectionId) => {
			const { body } = await request(connectionId, "/user");
			if (!record(body)) throw new Error("GitHub returned an invalid profile.");
			return body;
		},
		listRepositories: (connectionId, page) =>
			list(connectionId, "/user/repos", page, { sort: "updated" }),
		listIssues: async (connectionId, query) => {
			const page = await repositoryItems(connectionId, query, "issues");
			return {
				...page,
				items: page.items.filter((item) =>
					!Object.hasOwn(item, "pull_request")
				),
			};
		},
		listPullRequests: (connectionId, query) =>
			repositoryItems(connectionId, query, "pulls"),
		listActivity: async (connectionId, page = 1) => {
			const profile = await request(connectionId, "/user");
			if (
				!record(profile.body) || typeof profile.body.login !== "string" ||
				!/^[a-zA-Z0-9-]{1,39}$/.test(profile.body.login)
			) {
				throw new Error("GitHub returned an invalid profile.");
			}
			return list(
				connectionId,
				`/users/${encodeURIComponent(profile.body.login)}/events`,
				page,
			);
		},
	};
};
