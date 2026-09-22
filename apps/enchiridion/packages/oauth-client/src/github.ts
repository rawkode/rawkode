import { newHttpBatchRpcSession } from "capnweb";
import type { Connection } from "./contracts.ts";

export type GitHubRecord = Record<string, unknown>;
export type GitHubPage = {
	items: GitHubRecord[];
	nextPage: number | null;
};
export type GitHubActivity = GitHubRecord & {
	id: string;
	type: string;
	created_at: string;
	actor?: { login?: string };
	repo?: { name?: string };
	payload?: GitHubRecord;
};
export type RepositoryQuery = {
	owner: string;
	repository: string;
	state?: "open" | "closed" | "all";
	page?: number;
};

export interface GitHubApi {
	listConnections(): Promise<Connection[]>;
	getProfile(connectionId: string): Promise<GitHubRecord>;
	listRepositories(connectionId: string, page?: number): Promise<GitHubPage>;
	listIssues(connectionId: string, query: RepositoryQuery): Promise<GitHubPage>;
	listPullRequests(
		connectionId: string,
		query: RepositoryQuery,
	): Promise<GitHubPage>;
}

/** Activity is kept separate so consumers that only need repositories do not
 * expand the larger activity capability through Cap'n Web's mapped types. */
export interface GitHubActivityApi {
	listActivity(connectionId: string, page?: number): Promise<GitHubPage>;
}

export const createGitHubClient = (url = "/api/github/rpc") =>
	newHttpBatchRpcSession<GitHubApi>(url);
