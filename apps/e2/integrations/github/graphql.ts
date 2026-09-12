import { normalizeGitHubActivity } from "./src/activity.ts";
import type { Connection } from "@e2/oauth-client";
import type { GitHubActivityApi, GitHubApi } from "@e2/oauth-client/github";
import {
	type ApiContext,
	type IntegrationSchema,
	requestMemo,
} from "../../api/src/context.ts";

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
					const item = normalizeGitHubActivity(row);
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
    type GitHubActivity { connectionId: ID! id: ID! resourceId: ID! kind: String! title: String! url: String! repository: String! actor: String! createdAt: String! action: String! summary: String! number: Int eventType: String! }
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
