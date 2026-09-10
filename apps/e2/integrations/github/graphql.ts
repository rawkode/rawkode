import type { Connection } from "@e2/oauth-client";
import type { GitHubActivityApi, GitHubApi } from "@e2/oauth-client/github";
import {
	type ApiContext,
	type IntegrationSchema,
	requestMemo,
} from "../../api/src/context.ts";

type GitHubActivityKind = "issue" | "pullRequest" | "discussion";

type NormalizedActivity = {
	id: string;
	resourceId: string;
	kind: GitHubActivityKind;
	title: string;
	url: string;
	repository: string;
	actor: string;
	createdAt: string;
	action: string;
};

const read = async <T>(
	context: ApiContext,
	action: (api: GitHubApi & GitHubActivityApi) => Promise<T>,
): Promise<T> => {
	context.consume();
	if (!context.env.GITHUB_ADMIN) {
		throw new Error("Integration is not configured.");
	}
	using api = await context.env.GITHUB_ADMIN.admin(context.identity.ownerId);
	return await action(api);
};
const activity = (row: Record<string, unknown>): NormalizedActivity | null => {
	const payload = row.payload && typeof row.payload === "object"
		? row.payload as Record<string, unknown>
		: {};
	const type = String(row.type ?? "");
	const issue = payload.issue && typeof payload.issue === "object"
		? payload.issue as Record<string, unknown>
		: undefined;
	const pullRequest = payload.pull_request &&
			typeof payload.pull_request === "object"
		? payload.pull_request as Record<string, unknown>
		: undefined;
	const discussion = payload.discussion &&
			typeof payload.discussion === "object"
		? payload.discussion as Record<string, unknown>
		: undefined;
	const issuePullRequest = issue?.pull_request &&
			typeof issue.pull_request === "object"
		? issue.pull_request
		: undefined;
	const isPullRequest = Boolean(pullRequest || issuePullRequest) ||
		type.includes("PullRequest");
	const kind = isPullRequest
		? "pullRequest"
		: discussion || type.includes("Discussion")
		? "discussion"
		: issue || type.includes("Issue")
		? "issue"
		: null;
	if (!kind) return null;
	const resource = pullRequest ??
		(isPullRequest ? issue : discussion ?? issue) ??
		{};
	const resourceId = resource.node_id ?? resource.id ?? resource.number ??
		row.id;
	if (resourceId === undefined || resourceId === null) return null;
	return {
		id: String(row.id ?? ""),
		resourceId: String(resourceId),
		kind,
		title: String(resource.title ?? "GitHub activity"),
		url: String(resource.html_url ?? ""),
		repository: String(
			(row.repo as Record<string, unknown> | undefined)?.name ?? "",
		),
		actor: String(
			(row.actor as Record<string, unknown> | undefined)?.login ?? "",
		),
		createdAt: String(row.created_at ?? ""),
		action: String(payload.action ?? "updated"),
	};
};
const connections = (context: ApiContext) =>
	requestMemo(
		context,
		"github.connections",
		() => read(context, (api) => api.listConnections()),
	);
const activityRows = (context: ApiContext) =>
	requestMemo(context, "github.activity", async () => {
		const accounts = await connections(context);
		const results = await Promise.allSettled(
			accounts.map(async (account) => {
				const rows: Record<string, unknown>[] = [];
				let page: number | undefined = 1;
				for (let request = 0; request < 5 && page; request++) {
					const result = await read(
						context,
						(api) => api.listActivity(account.id, page),
					);
					rows.push(...result.items);
					page = result.nextPage ?? undefined;
				}
				return rows;
			}),
		);
		return results.flatMap((result, index) =>
			result.status === "fulfilled"
				? result.value.flatMap((row) => {
					const item = activity(row);
					return item
						? [{ ...item, connectionId: accounts[index]?.id ?? "" }]
						: [];
				})
				: []
		);
	});
export const githubGraphql: IntegrationSchema = {
	typeDefs: `
    extend type User { githubAccounts: [GitHubAccount!]! githubAccount(connectionId: ID!): GitHubAccount }
    type GitHubAccount { id: ID! accountLabel: String! repositories(page: Int = 1): GitHubRepositoryPage! }
    type GitHubRepository { id: ID! name: String! fullName: String! url: String! private: Boolean! }
    type GitHubRepositoryPage { items: [GitHubRepository!]! nextPage: Int }
    type GitHubActivity { connectionId: ID! id: ID! resourceId: ID! kind: String! title: String! url: String! repository: String! actor: String! createdAt: String! action: String! }
    extend type User { githubActivity(query: String!): [GitHubActivity!]! }
    extend type Today { githubActivity: [GitHubActivity!]! }
  `,
	fields: {
		"User.githubAccounts": (_source, _args, context) => connections(context),
		"User.githubAccount": async (_source, args, context) =>
			(await connections(context)).find((row) =>
				row.id === args.connectionId
			) ?? null,
		"GitHubAccount.repositories": async (source, args, context) => {
			const result = await read(
				context,
				(api) =>
					api.listRepositories(
						(source as Connection).id,
						args.page as number | undefined,
					),
			);
			return {
				items: result.items.map((row) => ({
					id: String(row.id),
					name: String(row.name ?? ""),
					fullName: String(row.full_name ?? ""),
					url: String(row.html_url ?? ""),
					private: row.private === true,
				})),
				nextPage: result.nextPage,
			};
		},
		"User.githubActivity": async (_source, args, context) => {
			const query = String(args.query ?? "").toLocaleLowerCase().trim();
			const rows = await activityRows(context);
			return rows.filter((row) =>
				!query ||
				[row.title, row.repository, row.actor].some((value) =>
					value.toLocaleLowerCase().includes(query)
				)
			).slice(0, 30);
		},
		"Today.githubActivity": async (source, _args, context) => {
			const today = source as { date?: string; from?: string; to?: string };
			const date = String(today.date);
			const start = today.from ?? `${date}T00:00:00.000Z`;
			const end = today.to ?? `${date}T23:59:59.999Z`;
			const rows = await activityRows(context);
			return rows.filter((row) =>
				row.createdAt >= start && row.createdAt < end
			);
		},
	},
};
