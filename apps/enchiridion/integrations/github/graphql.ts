import { beforeDeadline } from "./src/deadline.ts";
import { normalizeGitHubActivity } from "./src/activity.ts";
import type { Connection } from "@enchiridion/oauth-client";
import type {
	GitHubActivityApi,
	GitHubApi,
	GitHubPage,
} from "@enchiridion/oauth-client/github";
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
type ActivityRow = NonNullable<ReturnType<typeof normalizeGitHubActivity>> & {
	connectionId: string;
};
export interface GitHubActivityResult {
	rows: ActivityRow[];
	partial: boolean;
}
const fetchActivityResult = async (
	context: ApiContext,
	budgetMs: number,
): Promise<GitHubActivityResult> => {
	const deadline = Date.now() + budgetMs;
	let accounts: Connection[] | undefined;
	try {
		accounts = await beforeDeadline(connections(context), deadline);
	} catch {
		return { rows: [], partial: true };
	}
	if (!accounts || !context.env.GITHUB_ADMIN) {
		return { rows: [], partial: true };
	}
	const results = await Promise.all(accounts.map(async (account) => {
		const rows: Record<string, unknown>[] = [];
		let page: number | undefined = 1;
		let partial = false;
		try {
			const session = context.env.GITHUB_ADMIN!.admin(context.identity.ownerId);
			using api = await beforeDeadline(session, deadline);
			if (!api) {
				void session.then((late) => late[Symbol.dispose]()).catch(() => {});
				return { rows, partial: true };
			}
			for (
				let request = 0;
				request < 5 && page && Date.now() < deadline;
				request++
			) {
				context.consume();
				const result: GitHubPage | undefined = await beforeDeadline(
					api.listActivity(account.id, page),
					deadline,
				);
				if (!result) break;
				rows.push(...result.items);
				page = result.nextPage ?? undefined;
			}
		} catch {
			partial = true;
		}
		return { rows, partial: partial || page !== undefined };
	}));
	return {
		rows: results.flatMap((result, index) =>
			result.rows.flatMap((row) => {
				const item = normalizeGitHubActivity(row);
				return item
					? [{ ...item, connectionId: accounts[index]?.id ?? "" }]
					: [];
			})
		),
		partial: results.some((result) => result.partial),
	};
};
/** Rows and completion metadata share the same request and deadline, even when
 * GraphQL resolves the two fields concurrently or in a different order. */
export const loadGitHubActivityResult = (
	context: ApiContext,
	budgetMs = 8_000,
): Promise<GitHubActivityResult> =>
	requestMemo(
		context,
		"github.activity.result",
		() => fetchActivityResult(context, budgetMs),
	);
export const loadGitHubActivity = async (
	context: ApiContext,
	budgetMs = 8_000,
) => (await loadGitHubActivityResult(context, budgetMs)).rows;
const activityRows = (context: ApiContext) => loadGitHubActivity(context);
export const githubGraphql: IntegrationSchema = {
	typeDefs: `
    extend type User { githubAccounts: [GitHubAccount!]! githubAccount(connectionId: ID!): GitHubAccount }
    type GitHubAccount { id: ID! accountLabel: String! repositories(page: Int = 1): GitHubRepositoryPage! }
    type GitHubRepository { id: ID! name: String! fullName: String! url: String! private: Boolean! }
    type GitHubRepositoryPage { items: [GitHubRepository!]! nextPage: Int }
    type GitHubActivity { connectionId: ID! id: ID! resourceId: ID! kind: String! title: String! url: String! repository: String! actor: String! createdAt: String! action: String! summary: String! number: Int eventType: String! }
    extend type User { githubActivity(query: String!): [GitHubActivity!]! }
    extend type Today { githubActivity: [GitHubActivity!]! githubActivityPartial: Boolean! }
  `,
	fields: {
		"Today.githubActivityPartial": async (_source, _args, context) =>
			(await loadGitHubActivityResult(context)).partial,
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
