import { strict as assert } from "node:assert";
import { execute, parse, validate } from "graphql";
import { googleGraphql } from "../../integrations/google/graphql.ts";
import { githubGraphql } from "../../integrations/github/graphql.ts";
import { composeSchema } from "./schema.ts";
import { type ApiContext, type ApiEnv, createContext } from "./context.ts";
import { enforceQueryBudget } from "./limits.ts";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import { todayGraphql } from "./today.ts";
import { entitiesGraphql } from "../../core/entities/graphql.ts";
import type { EntitiesApi, MutationProvenance } from "@e2/entities";

Deno.test("integration-owned schemas compose independently onto shared User", () => {
	const google = composeSchema([googleGraphql]).schema;
	assert.ok(google.getType("GoogleAccount"));
	assert.equal(google.getType("GitHubAccount"), undefined);
	const both = composeSchema([googleGraphql, githubGraphql]).schema;
	assert.ok(both.getType("GoogleAccount"));
	assert.ok(both.getType("GitHubAccount"));
	assert.equal(
		validate(google, parse("{ me { githubAccounts { id } } }")).length,
		1,
	);
});

Deno.test("entities GraphQL uses authenticated owner for search and mutation provenance", async () => {
	const owners: string[] = [],
		searches: unknown[][] = [],
		actors: MutationProvenance[] = [];
	const api = {
		listTags: () => Promise.resolve([]),
		searchEntities: (query: string, options: unknown) => {
			searches.push([query, options]);
			return Promise.resolve([{
				id: "00000000-0000-4000-8000-000000000001",
				label: "Ada Lovelace",
				bodyDocumentId: "entity:00000000-0000-4000-8000-000000000001",
				tagIds: ["base:person"],
				rootId: "base:person",
			}]);
		},
		createEntity: (
			input: { label: string; tagIds: readonly string[] },
			provenance: MutationProvenance,
		) => {
			actors.push(provenance);
			return Promise.resolve({
				id: "00000000-0000-4000-8000-000000000002",
				label: input.label,
				bodyDocumentId: "entity:00000000-0000-4000-8000-000000000002",
				tagIds: input.tagIds,
				values: { "field:person:name": input.label },
				aliases: [],
				archived: false,
				revision: 1,
			});
		},
		[Symbol.dispose]: () => {},
	} as unknown as EntitiesApi & Disposable;
	const env = {
		ENTITIES_ADMIN: {
			admin: (owner: string) => {
				owners.push(owner);
				return Promise.resolve(api);
			},
		},
	} as unknown as ApiEnv;
	const { schema, fieldResolver } = composeSchema([entitiesGraphql]);
	const contextValue = createContext(env, {
		ownerId: "access:alice",
		email: "alice@example.com",
	});
	const search = await execute({
		schema,
		fieldResolver,
		document: parse(
			`query { me { entities(query: "ada", rootId: "base:person", limit: 5) { id label rootId } } }`,
		),
		contextValue,
	});
	assert.equal(search.errors, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(search.data)), {
		me: {
			entities: [{
				id: "00000000-0000-4000-8000-000000000001",
				label: "Ada Lovelace",
				rootId: "base:person",
			}],
		},
	});
	const create = await execute({
		schema,
		fieldResolver,
		document: parse(
			`mutation { createEntity(input: { label: "Grace Hopper", tagIds: ["base:person"] }) { id label values { fieldId text } } }`,
		),
		contextValue,
	});
	assert.equal(create.errors, undefined);
	const otherOwner = await execute({
		schema,
		fieldResolver,
		document: parse(`query { me { entities(query: "ada", limit: 1) { id } } }`),
		contextValue: createContext(env, {
			ownerId: "access:bob",
			email: "bob@example.com",
		}),
	});
	assert.equal(otherOwner.errors, undefined);
	assert.deepEqual(owners, ["access:alice", "access:alice", "access:bob"]);
	assert.deepEqual(searches, [
		["ada", { rootId: "base:person", limit: 5 }],
		["ada", { rootId: undefined, limit: 1 }],
	]);
	assert.deepEqual(actors, [{
		actor: "access:alice",
		cause: "graphql:create-entity",
		rationale: "Authenticated user created an entity.",
	}]);
	assert.ok(
		validate(
			schema,
			parse(
				`mutation { createEntity(input: { label: "Mallory", tagIds: ["base:person"], actor: "access:mallory" }) { id } }`,
			),
		).length > 0,
	);
});

Deno.test("Supertag GraphQL exposes inherited field origins, impact, and revisioned admin mutations", async () => {
	const calls: unknown[][] = [];
	const tag = {
		id: "00000000-0000-4000-8000-000000000010",
		name: "Engineer",
		kind: "user" as const,
		parentId: "base:person",
		rootId: "base:person" as const,
		depth: 1,
		revision: 2,
		archived: false,
	};
	const details = {
		tag,
		fields: [{
			id: "field:person:name",
			tagId: "base:person",
			key: "name",
			label: "Name",
			type: "text" as const,
			cardinality: "single" as const,
			required: true,
			archived: false,
			originTagId: "base:person",
			inherited: true,
		}],
		directEntityCount: 3,
		inheritedEntityCount: 1,
		activeChildTagCount: 0,
	};
	const api = {
		getTag: () => Promise.resolve(details),
		getTagArchiveImpact: () =>
			Promise.resolve({
				allowed: false,
				entityCount: 4,
				descendantTagCount: 0,
				valueCount: 0,
			}),
		renameUserTag: (...args: unknown[]) => {
			calls.push(args);
			return Promise.resolve({
				...details,
				tag: { ...tag, name: "Staff Engineer", revision: 3 },
			});
		},
		[Symbol.dispose]: () => {},
	} as unknown as EntitiesApi & Disposable;
	const env = {
		ENTITIES_ADMIN: { admin: () => Promise.resolve(api) },
	} as unknown as ApiEnv;
	const { schema, fieldResolver } = composeSchema([entitiesGraphql]);
	const contextValue = createContext(env, {
		ownerId: "access:alice",
		email: "alice@example.com",
	});
	const read = await execute({
		schema,
		fieldResolver,
		document: parse(
			`query { me { supertag(id: "tag") { tag { name revision } fields { key originTagId inherited } directEntityCount } supertagArchiveImpact(id: "tag") { allowed entityCount } } }`,
		),
		contextValue,
	});
	assert.equal(read.errors, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(read.data)), {
		me: {
			supertag: {
				tag: { name: "Engineer", revision: 2 },
				fields: [{ key: "name", originTagId: "base:person", inherited: true }],
				directEntityCount: 3,
			},
			supertagArchiveImpact: { allowed: false, entityCount: 4 },
		},
	});
	const renamed = await execute({
		schema,
		fieldResolver,
		document: parse(
			`mutation { renameUserTag(input: { id: "tag", name: "Staff Engineer", expectedRevision: 2 }) { tag { name revision } } }`,
		),
		contextValue,
	});
	assert.equal(renamed.errors, undefined);
	assert.deepEqual(calls[0]?.slice(0, 3), ["tag", "Staff Engineer", 2]);
	assert.deepEqual(calls[0]?.[3], {
		actor: "access:alice",
		cause: "graphql:rename-user-tag",
		rationale: "Authenticated user renamed a Supertag.",
	});
});

Deno.test("Today rejects impossible calendar dates without throwing", () => {
	const resolveToday = todayGraphql.fields["User.today"] as (
		source: unknown,
		args: Record<string, unknown>,
		context: ApiContext,
	) => { id: string; from: string };
	const result = resolveToday({}, { date: "2024-02-31" }, {} as ApiContext);
	assert.notEqual(result.id, "daily:2024-02-31");
	assert.match(result.from, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
});

Deno.test("Google contacts resolve through owner-scoped RPC and preserve cursor without exposing raw fields", async () => {
	const owners: string[] = [];
	let disposed = 0;
	const env = {
		GOOGLE_ADMIN: {
			admin: (owner: string) => {
				owners.push(owner);
				let active = true;
				const api = {
					listConnections: () =>
						Promise.resolve([{
							id: "connection",
							accountLabel: "alice@example.com",
						}]),
					listRecords: async (
						id: string,
						collection: string,
						after?: string,
					) => {
						await Promise.resolve();
						assert.equal(active, true);
						assert.equal(id, "connection");
						assert.equal(collection, "contacts");
						assert.equal(after, "previous");
						return {
							records: [{
								id: "people/123",
								data: {
									names: [{ displayName: "Alice" }],
									emailAddresses: [{ value: "alice@example.com" }],
									phoneNumbers: [{ value: "+123" }],
									privateUnknown: "hidden",
								},
							}],
							nextCursor: "next",
						};
					},
					[Symbol.dispose]: () => {
						active = false;
						disposed++;
					},
				} as unknown as CalendarApi & Disposable;
				return Promise.resolve(api);
			},
		},
	} as unknown as ApiEnv;
	const { schema, fieldResolver } = composeSchema([googleGraphql]);
	const document = parse(
		`query Contacts($id:ID!,$after:String){ me { id googleAccount(connectionId:$id){ contacts(after:$after){ records { ...Contact } nextCursor } } } } fragment Contact on GoogleContact { id displayName emails phones }`,
	);
	assert.deepEqual(validate(schema, document), []);
	enforceQueryBudget(document, "Contacts");
	const result = await execute({
		schema,
		fieldResolver,
		document,
		variableValues: { id: "connection", after: "previous" },
		contextValue: createContext(env, {
			ownerId: "access:alice",
			email: "alice@example.com",
		}),
	});
	assert.equal(result.errors, undefined);
	assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
		me: {
			id: "access:alice",
			googleAccount: {
				contacts: {
					records: [{
						id: "people/123",
						displayName: "Alice",
						emails: ["alice@example.com"],
						phones: ["+123"],
					}],
					nextCursor: "next",
				},
			},
		},
	});
	assert.deepEqual(owners, ["access:alice", "access:alice"]);
	assert.equal(disposed, 2);
	assert.ok(
		validate(
			schema,
			parse(
				'{ me { googleAccount(connectionId:"connection", ownerId:"victim") { id } } }',
			),
		).length > 0,
	);
});

Deno.test("expanded fragment aliases count toward complexity and cycles fail GraphQL validation", () => {
	const { schema } = composeSchema([googleGraphql]);
	const document = parse(
		`{ me { ${
			Array.from(
				{ length: 51 },
				(_, i) => `a${i}:googleAccount(connectionId:"x"){ ...Account }`,
			).join(" ")
		} } } fragment Account on GoogleAccount { id accountLabel }`,
	);
	assert.deepEqual(validate(schema, document), []);
	assert.throws(() => enforceQueryBudget(document), /complexity/);
	assert.ok(
		validate(
			schema,
			parse(
				"{ me { ...A } } fragment A on User { ...B } fragment B on User { ...A }",
			),
		).length > 0,
	);
	assert.throws(
		() =>
			enforceQueryBudget(
				parse("query One { me { id } } query Two { me { id } }"),
			),
		/Select/,
	);
	assert.doesNotThrow(() =>
		enforceQueryBudget(
			parse('mutation { mergeEntities(input:{fromId:"a",intoId:"b"}) { id } }'),
		)
	);
	assert.throws(
		() =>
			enforceQueryBudget(
				parse(
					'mutation { first:mergeEntities(input:{fromId:"a",intoId:"b"}) { id } second:mergeEntities(input:{fromId:"c",intoId:"d"}) { id } }',
				),
			),
		/exactly one root field/,
	);
});

Deno.test("GitHub Today includes supported resources across activity pages", async () => {
	const requestedPages: number[] = [];
	const githubApi = {
		listConnections: () =>
			Promise.resolve([{
				id: "github-connection",
				accountLabel: "alice",
			}]),
		listActivity: (_connectionId: string, page = 1) => {
			requestedPages.push(page);
			return Promise.resolve(
				page === 1
					? {
						items: [{
							id: "push-activity",
							type: "PushEvent",
							created_at: "2026-09-10T09:00:00Z",
						}, {
							id: "issue-activity",
							type: "IssuesEvent",
							created_at: "2026-09-10T10:00:00Z",
							repo: { name: "alice/project" },
							actor: { login: "alice" },
							payload: {
								action: "opened",
								issue: {
									node_id: "issue-node",
									title: "Fix the thing",
									html_url: "https://github.com/alice/project/issues/1",
								},
							},
						}],
						nextPage: 2,
					}
					: {
						items: [{
							id: "pull-request-activity",
							type: "PullRequestEvent",
							created_at: "2026-09-10T11:00:00Z",
							repo: { name: "alice/project" },
							actor: { login: "alice" },
							payload: {
								action: "opened",
								pull_request: {
									node_id: "pull-request-node",
									title: "Ship the thing",
									html_url: "https://github.com/alice/project/pull/2",
								},
							},
						}, {
							id: "old-discussion-activity",
							type: "DiscussionEvent",
							created_at: "2026-09-09T11:00:00Z",
							payload: {
								discussion: {
									node_id: "discussion-node",
									title: "Yesterday's discussion",
									html_url: "https://github.com/alice/project/discussions/3",
								},
							},
						}, {
							id: "pull-request-comment-activity",
							type: "IssueCommentEvent",
							created_at: "2026-09-10T11:30:00Z",
							repo: { name: "alice/project" },
							actor: { login: "alice" },
							payload: {
								action: "created",
								issue: {
									node_id: "pull-request-node",
									title: "Ship the thing",
									html_url: "https://github.com/alice/project/pull/2",
									pull_request: {
										url: "https://api.github.com/repos/alice/project/pulls/2",
									},
								},
							},
						}],
						nextPage: null,
					},
			);
		},
		[Symbol.dispose]: () => {},
	} as unknown as Awaited<
		ReturnType<NonNullable<ApiEnv["GITHUB_ADMIN"]>["admin"]>
	>;
	const env = {
		GITHUB_ADMIN: {
			admin: () => Promise.resolve(githubApi),
		},
	} as unknown as ApiEnv;
	const { schema, fieldResolver } = composeSchema([
		todayGraphql,
		githubGraphql,
	]);
	const document = parse(`
		query {
			me {
				all: githubActivity(query: "") {
					id resourceId kind title
				}
				today: today(
					date: "2026-09-10"
					from: "2026-09-10T00:00:00.000Z"
					to: "2026-09-11T00:00:00.000Z"
				) {
					githubActivity { id resourceId kind title }
				}
			}
		}
	`);
	assert.deepEqual(validate(schema, document), []);
	const result = await execute({
		schema,
		fieldResolver,
		document,
		contextValue: createContext(env, {
			ownerId: "access:alice",
			email: "alice@example.com",
		}),
	});
	assert.equal(result.errors, undefined);
	assert.deepEqual(
		JSON.parse(JSON.stringify(result.data)),
		{
			me: {
				all: [
					{
						id: "issue-activity",
						resourceId: "issue-node",
						kind: "issue",
						title: "Fix the thing",
					},
					{
						id: "pull-request-activity",
						resourceId: "pull-request-node",
						kind: "pullRequest",
						title: "Ship the thing",
					},
					{
						id: "old-discussion-activity",
						resourceId: "discussion-node",
						kind: "discussion",
						title: "Yesterday's discussion",
					},
					{
						id: "pull-request-comment-activity",
						resourceId: "pull-request-node",
						kind: "pullRequest",
						title: "Ship the thing",
					},
				],
				today: {
					githubActivity: [
						{
							id: "issue-activity",
							resourceId: "issue-node",
							kind: "issue",
							title: "Fix the thing",
						},
						{
							id: "pull-request-activity",
							resourceId: "pull-request-node",
							kind: "pullRequest",
							title: "Ship the thing",
						},
						{
							id: "pull-request-comment-activity",
							resourceId: "pull-request-node",
							kind: "pullRequest",
							title: "Ship the thing",
						},
					],
				},
			},
		},
	);
	assert.deepEqual(requestedPages, [1, 2]);
});
