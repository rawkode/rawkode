import {
	INTEGRATION_TAGS,
	type IntegrationTagId,
	type ProjectionBatch,
	type ProjectionRecord,
} from "@e2/entities";
import {
	GitHubRateLimitError,
	githubRequest,
	installationAccessToken,
	sha256,
} from "./app-auth.ts";
import type {
	EntitiesAdminBinding,
	GitHubEnv,
	InstallationIdentity,
} from "./env.ts";
import type {
	InstallationDatabase,
	InstallationStatement,
} from "./installation-storage.ts";

export const GITHUB_RECONCILE_PAGE_SIZE = 50;
export const GITHUB_PROJECTION_BATCH_SIZE = 50;

type ResourceKind =
	| "repository"
	| "user"
	| "organization"
	| "issue"
	| "pullRequest"
	| "discussion";

interface CanonicalProjection extends ProjectionRecord {
	projectionId: string;
}

interface CursorRow {
	kind: "repositories" | "issues" | "pullRequests" | "discussions";
	repository_id: string;
	cursor: string | null;
	generation: string;
}

interface OutboxRow {
	sequence: number;
	projection_id: string;
	resource_type: ResourceKind;
	resource_id: string;
	source_revision: string;
	tag_id: IntegrationTagId;
	label: string | null;
	aliases: string;
	values: string | null;
	deleted: number;
}

const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;

const string = (value: unknown, max = 1_000): string =>
	typeof value === "string" ? value.trim().slice(0, max) : "";

const identifier = (value: unknown): string => {
	if (
		(typeof value !== "string" && typeof value !== "number") ||
		!String(value) || String(value).length > 2_000
	) throw new Error("GitHub returned an invalid resource ID");
	return String(value);
};

const url = (value: unknown): string => {
	const candidate = string(value, 8_192);
	try {
		const parsed = new URL(candidate);
		return ["http:", "https:"].includes(parsed.protocol) && !parsed.username &&
				!parsed.password
			? candidate
			: "";
	} catch {
		return "";
	}
};

const unique = (
	values: readonly string[],
): string[] => [...new Set(values.filter(Boolean))];

const tagFor = (kind: ResourceKind): IntegrationTagId =>
	({
		repository: INTEGRATION_TAGS.githubRepository,
		user: INTEGRATION_TAGS.githubUser,
		organization: INTEGRATION_TAGS.githubOrganization,
		issue: INTEGRATION_TAGS.githubIssue,
		pullRequest: INTEGRATION_TAGS.githubPullRequest,
		discussion: INTEGRATION_TAGS.githubDiscussion,
	})[kind];

const valuesFor = (
	kind: ResourceKind,
	label: string,
	data: Record<string, unknown>,
): Record<string, unknown> => {
	const resourceUrl = url(data.url ?? data.html_url);
	if (kind === "user") {
		const values: Record<string, unknown> = { "field:person:name": label };
		const avatar = url(data.avatarUrl ?? data.avatar_url);
		if (avatar) values["field:person:avatar"] = avatar;
		return values;
	}
	if (kind === "organization") {
		const values: Record<string, unknown> = { "field:company:name": label };
		if (resourceUrl) values["field:company:url"] = resourceUrl;
		return values;
	}
	if (kind === "repository") {
		const values: Record<string, unknown> = {
			"field:project:name": label,
			"field:project:status": "active",
		};
		if (resourceUrl) values["field:project:url"] = resourceUrl;
		return values;
	}
	if (kind === "discussion") {
		const values: Record<string, unknown> = {
			"field:conversation:title": label,
		};
		const createdAt = string(data.createdAt);
		if (createdAt && Number.isFinite(Date.parse(createdAt))) {
			values["field:conversation:started_at"] = createdAt;
		}
		if (resourceUrl) values["field:conversation:url"] = resourceUrl;
		return values;
	}
	const values: Record<string, unknown> = {
		"field:task:title": label,
		"field:task:status": string(data.state).toLocaleLowerCase() || "unknown",
	};
	if (resourceUrl) values["field:task:url"] = resourceUrl;
	return values;
};

export const githubProjection = async (
	connectionId: string,
	kind: ResourceKind,
	data: Record<string, unknown>,
	deleted = false,
): Promise<CanonicalProjection> => {
	const resourceId = identifier(data.node_id ?? data.id);
	const login = string(data.login);
	const label = kind === "repository"
		? string(data.full_name ?? data.name)
		: login || string(data.name ?? data.title) || `GitHub ${kind}`;
	const aliases = deleted ? [] : unique([
		login,
		string(data.name),
		string(data.full_name),
	]).filter((alias) => alias !== label);
	const values = deleted ? undefined : valuesFor(kind, label, data);
	const normalized = deleted
		? { resourceId, deleted: true }
		: { resourceId, label, aliases, values, deleted: false };
	const sourceRevision = `${deleted ? "deleted" : "active"}:${await sha256(
		JSON.stringify(normalized),
	)}`;
	return {
		projectionId: JSON.stringify([
			"github",
			connectionId,
			kind,
			resourceId,
			sourceRevision,
		]),
		resourceType: kind,
		resourceId,
		sourceRevision,
		tagId: tagFor(kind),
		...(deleted ? {} : { label, aliases, values }),
		deleted,
	};
};

const enqueue = (
	db: InstallationDatabase,
	projection: CanonicalProjection,
	now: number,
): InstallationStatement =>
	db.prepare(
		`INSERT OR IGNORE INTO github_entity_projection_outbox
      (projection_id,resource_type,resource_id,source_revision,tag_id,label,
       aliases,"values",deleted,created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		projection.projectionId,
		projection.resourceType,
		projection.resourceId,
		projection.sourceRevision,
		projection.tagId,
		projection.label ?? null,
		JSON.stringify(projection.aliases ?? []),
		projection.values ? JSON.stringify(projection.values) : null,
		projection.deleted ? 1 : 0,
		now,
	);

const persist = (
	db: InstallationDatabase,
	projection: CanonicalProjection,
	repositoryId: string,
	generation: string,
	now: number,
): InstallationStatement[] => [
	db.prepare(
		`INSERT INTO github_records
      (resource_type,resource_id,repository_id,data,source_revision,active,generation)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(resource_type,resource_id) DO UPDATE SET
       repository_id=excluded.repository_id,
       data=excluded.data,
       source_revision=excluded.source_revision,
       active=excluded.active,
       generation=excluded.generation`,
	).bind(
		projection.resourceType,
		projection.resourceId,
		repositoryId,
		JSON.stringify({
			label: projection.label,
			aliases: projection.aliases,
			values: projection.values,
		}),
		projection.sourceRevision,
		projection.deleted ? 0 : 1,
		generation,
	),
	enqueue(db, projection, now),
];

const resetCursor = (
	db: InstallationDatabase,
	kind: CursorRow["kind"],
	repositoryId: string,
	now: number,
	guardDelivery?: string,
): InstallationStatement =>
	db.prepare(
		`INSERT INTO github_sync_cursors
      (kind,repository_id,cursor,generation,status,updated_at)
     SELECT ?, ?, NULL, ?, 'pending', ?
      WHERE ? IS NULL OR EXISTS (
        SELECT 1 FROM github_webhook_deliveries
         WHERE id = ? AND processed = 0
      )
     ON CONFLICT(kind,repository_id) DO UPDATE SET
       cursor=NULL,
       generation=excluded.generation,
       status='pending',
       updated_at=excluded.updated_at`,
	).bind(
		kind,
		repositoryId,
		crypto.randomUUID(),
		now,
		guardDelivery ?? null,
		guardDelivery ?? null,
	);

export const initializeInstallation = async (
	db: InstallationDatabase,
	identity: InstallationIdentity,
): Promise<void> => {
	const now = Date.now();
	await db.batch([
		db.prepare(
			`INSERT INTO installation_state
        (installation_id,owner_id,account_id,account_login,target_type,status)
       VALUES (?, ?, ?, ?, ?, 'active')
       ON CONFLICT(installation_id) DO UPDATE SET
         owner_id=excluded.owner_id,
         account_id=excluded.account_id,
         account_login=excluded.account_login,
         target_type=excluded.target_type,
         status='active'`,
		).bind(
			identity.installationId,
			identity.ownerId,
			identity.accountId,
			identity.accountLogin,
			identity.targetType,
		),
		resetCursor(db, "repositories", "", now),
	]);
};

const webhookRepositoryId = (payload: Record<string, unknown>): string =>
	object(payload.repository) ? identifier(object(payload.repository)!.id) : "";

export const recordWebhook = async (
	db: InstallationDatabase,
	deliveryId: string,
	event: string,
	payload: Record<string, unknown>,
): Promise<{ duplicate: boolean }> => {
	const now = Date.now();
	const repo = webhookRepositoryId(payload);
	const cursors: InstallationStatement[] = [];
	if (
		["installation", "installation_repositories", "repository"].includes(event)
	) {
		cursors.push(resetCursor(db, "repositories", "", now, deliveryId));
	}
	if (repo && ["issues", "pull_request", "discussion"].includes(event)) {
		const kind = event === "issues"
			? "issues"
			: event === "pull_request"
			? "pullRequests"
			: "discussions";
		cursors.push(resetCursor(db, kind, repo, now, deliveryId));
	}
	const action = string(payload.action);
	const status = event === "installation" && action === "deleted"
		? "deleted"
		: event === "installation" && action === "suspend"
		? "suspended"
		: event === "installation" && action === "unsuspend"
		? "active"
		: null;
	const results = await db.batch([
		db.prepare(
			"INSERT OR IGNORE INTO github_webhook_deliveries(id,event,received_at,processed) VALUES (?, ?, ?, 0)",
		).bind(deliveryId, event, now),
		...cursors,
		...(status
			? [
				db.prepare(
					`UPDATE installation_state SET status = ?
           WHERE ? IN (SELECT id FROM github_webhook_deliveries WHERE processed = 0)`,
				).bind(status, deliveryId),
			]
			: []),
		db.prepare(
			"UPDATE github_webhook_deliveries SET processed = 1 WHERE id = ? AND processed = 0",
		).bind(deliveryId),
	]);
	return { duplicate: results[0]?.meta.changes !== 1 };
};

const outboxRecord = (row: OutboxRow): ProjectionRecord => ({
	resourceType: row.resource_type,
	resourceId: row.resource_id,
	sourceRevision: row.source_revision,
	tagId: row.tag_id,
	...(row.label ? { label: row.label } : {}),
	aliases: JSON.parse(row.aliases) as string[],
	...(row.values
		? { values: JSON.parse(row.values) as Record<string, unknown> }
		: {}),
	deleted: row.deleted === 1,
});

export const drainGitHubProjectionOutbox = async (
	db: InstallationDatabase,
	binding: EntitiesAdminBinding | undefined,
	identity: InstallationIdentity,
	limit = GITHUB_PROJECTION_BATCH_SIZE,
): Promise<{ delivered: number; pending: boolean }> => {
	if (!binding) return { delivered: 0, pending: false };
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("Invalid GitHub projection batch size");
	}
	const { results } = await db.prepare(
		`SELECT sequence,projection_id,resource_type,resource_id,source_revision,
              tag_id,label,aliases,"values",deleted
       FROM github_entity_projection_outbox ORDER BY sequence LIMIT ?`,
	).bind(limit).all<OutboxRow>();
	if (!results.length) return { delivered: 0, pending: false };
	try {
		using entities = await binding.admin(identity.ownerId);
		const batch: ProjectionBatch = {
			provider: "github",
			connectionId: identity.installationId,
			records: results.map(outboxRecord),
			provenance: {
				actor: "integration:github-app",
				cause: `github-outbox:${results[0]!.sequence}-${
					results.at(-1)!.sequence
				}`,
				rationale: "Project a reconciled GitHub App observation.",
			},
		};
		await entities.upsertProjectionBatch(batch);
		await db.batch(results.map((row) =>
			db.prepare(
				"DELETE FROM github_entity_projection_outbox WHERE sequence = ? AND projection_id = ?",
			).bind(row.sequence, row.projection_id)
		));
	} catch {
		await db.batch(results.map((row) =>
			db.prepare(
				"UPDATE github_entity_projection_outbox SET attempts=attempts+1,last_error='Entity projection failed' WHERE sequence=? AND projection_id=?",
			).bind(row.sequence, row.projection_id)
		));
		throw new Error("GitHub entity projection will retry");
	}
	const pending = await db.prepare(
		"SELECT 1 AS pending FROM github_entity_projection_outbox LIMIT 1",
	).first();
	return { delivered: results.length, pending: pending !== null };
};

const bearerRequest = (
	env: GitHubEnv,
	token: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> =>
	githubRequest(env, path, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...Object.fromEntries(new Headers(init.headers).entries()),
		},
	});

export const githubHasNextPage = (response: Response): boolean =>
	/<[^>]+>;\s*rel="next"/.test(response.headers.get("Link") ?? "");

const ownerKind = (value: Record<string, unknown>): ResourceKind =>
	string(value.type ?? value.__typename).toLocaleLowerCase() === "organization"
		? "organization"
		: "user";

const repositoryPage = async (
	db: InstallationDatabase,
	env: GitHubEnv,
	identity: InstallationIdentity,
	token: string,
	cursor: CursorRow,
) => {
	if (cursor.cursor === "archive") {
		const { results } = await db.prepare(
			`SELECT resource_type,resource_id FROM github_records
		   WHERE active=1 AND (
		     resource_type='repository' AND generation != ? OR
		     repository_id IN (SELECT id FROM github_repositories WHERE active=1 AND generation != ?)
		   ) ORDER BY resource_type,resource_id LIMIT ?`,
		).bind(cursor.generation, cursor.generation, GITHUB_RECONCILE_PAGE_SIZE)
			.all<{ resource_type: ResourceKind; resource_id: string }>();
		const now = Date.now();
		if (results.length) {
			const statements: InstallationStatement[] = [];
			for (const row of results) {
				const projection = await githubProjection(
					identity.installationId,
					row.resource_type,
					{ id: row.resource_id },
					true,
				);
				statements.push(
					enqueue(db, projection, now),
					db.prepare(
						"UPDATE github_records SET active=0,source_revision=? WHERE resource_type=? AND resource_id=?",
					).bind(projection.sourceRevision, row.resource_type, row.resource_id),
				);
			}
			await db.batch(statements);
			return;
		}
		const statements: InstallationStatement[] = [
			db.prepare(
				"UPDATE github_repositories SET active=0 WHERE generation != ?",
			).bind(cursor.generation),
			db.prepare(
				"UPDATE github_sync_cursors SET status='complete',cursor=NULL,updated_at=? WHERE kind='repositories' AND repository_id='' AND generation=?",
			).bind(now, cursor.generation),
		];
		for (const kind of ["issues", "pullRequests", "discussions"] as const) {
			statements.push(
				db.prepare(
					`INSERT INTO github_sync_cursors
          (kind,repository_id,cursor,generation,status,updated_at)
         SELECT ?,id,NULL,? || ':' || id,'pending',?
           FROM github_repositories WHERE active=1
         ON CONFLICT(kind,repository_id) DO UPDATE SET
           cursor=NULL,generation=excluded.generation,status='pending',
           updated_at=excluded.updated_at`,
				).bind(kind, cursor.generation, now),
			);
		}
		await db.batch(statements);
		return;
	}
	const page = Number(cursor.cursor ?? "1");
	if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
		throw new Error("Invalid repository cursor");
	}
	const response = await bearerRequest(
		env,
		token,
		`/installation/repositories?per_page=${GITHUB_RECONCILE_PAGE_SIZE}&page=${page}`,
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("GitHub repositories could not be reconciled");
	}
	const body = object(await response.json());
	const rows = Array.isArray(body?.repositories)
		? body!.repositories.map(object).filter(Boolean) as Record<
			string,
			unknown
		>[]
		: [];
	const now = Date.now();
	const projections = await Promise.all(rows.flatMap((repo) => {
		const owner = object(repo.owner);
		return [
			githubProjection(identity.installationId, "repository", repo),
			...(owner
				? [githubProjection(
					identity.installationId,
					ownerKind(owner),
					owner,
				)]
				: []),
		];
	}));
	const statements: InstallationStatement[] = [];
	for (const repo of rows) {
		const id = identifier(repo.id);
		const projection = projections.find((item) =>
			item.resourceType === "repository" &&
			item.resourceId === identifier(repo.node_id ?? repo.id)
		)!;
		statements.push(
			db.prepare(
				`INSERT INTO github_repositories
          (id,node_id,owner_login,owner_type,name,full_name,url,private,active,generation,source_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           node_id=excluded.node_id,owner_login=excluded.owner_login,
           owner_type=excluded.owner_type,name=excluded.name,
           full_name=excluded.full_name,url=excluded.url,private=excluded.private,
           active=1,generation=excluded.generation,
           source_revision=excluded.source_revision`,
			).bind(
				id,
				identifier(repo.node_id ?? repo.id),
				string(object(repo.owner)?.login) || "unknown",
				string(object(repo.owner)?.type) || "User",
				string(repo.name) || id,
				string(repo.full_name) || string(repo.name) || id,
				url(repo.html_url ?? repo.url),
				repo.private === true ? 1 : 0,
				cursor.generation,
				projection.sourceRevision,
			),
		);
	}
	for (const projection of projections) {
		statements.push(...persist(
			db,
			projection,
			projection.resourceType === "repository"
				? rows.find((repo) =>
					identifier(repo.node_id ?? repo.id) === projection.resourceId
				)?.id?.toString() ?? ""
				: "",
			cursor.generation,
			now,
		));
	}
	const next = githubHasNextPage(response);
	if (next) {
		statements.push(
			db.prepare(
				"UPDATE github_sync_cursors SET cursor=?,updated_at=? WHERE kind='repositories' AND repository_id='' AND generation=?",
			).bind(String(page + 1), now, cursor.generation),
		);
	} else {
		statements.push(
			db.prepare(
				"UPDATE github_sync_cursors SET cursor='archive',updated_at=? WHERE kind='repositories' AND repository_id='' AND generation=?",
			).bind(now, cursor.generation),
		);
	}
	await db.batch(statements);
};

const collectionQuery = (
	kind: Exclude<CursorRow["kind"], "repositories">,
): string => {
	const field = kind;
	const fragment = kind === "issues"
		? "id number title url state updatedAt author { __typename login avatarUrl url ... on User { databaseId } ... on Organization { databaseId } }"
		: kind === "pullRequests"
		? "id number title url state updatedAt author { __typename login avatarUrl url ... on User { databaseId } ... on Organization { databaseId } }"
		: "id number title url createdAt updatedAt author { __typename login avatarUrl url ... on User { databaseId } ... on Organization { databaseId } }";
	return `query Mirror($owner:String!,$name:String!,$after:String){
    repository(owner:$owner,name:$name){
      ${field}(first:${GITHUB_RECONCILE_PAGE_SIZE},after:$after){
        nodes { ${fragment} }
        pageInfo { hasNextPage endCursor }
      }
    }
    rateLimit { remaining resetAt }
  }`;
};

const collectionPage = async (
	db: InstallationDatabase,
	env: GitHubEnv,
	identity: InstallationIdentity,
	token: string,
	cursor: CursorRow,
) => {
	if (cursor.kind === "repositories") {
		throw new Error("Invalid collection cursor");
	}
	const repo = await db.prepare(
		"SELECT owner_login,name FROM github_repositories WHERE id=? AND active=1",
	).bind(cursor.repository_id).first<{ owner_login: string; name: string }>();
	if (!repo) {
		await db.prepare(
			"UPDATE github_sync_cursors SET status='complete',cursor=NULL,updated_at=? WHERE kind=? AND repository_id=? AND generation=?",
		).bind(Date.now(), cursor.kind, cursor.repository_id, cursor.generation)
			.run();
		return;
	}
	const response = await bearerRequest(env, token, "/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query: collectionQuery(cursor.kind),
			variables: {
				owner: repo.owner_login,
				name: repo.name,
				after: cursor.cursor,
			},
		}),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("GitHub resources could not be reconciled");
	}
	const body = object(await response.json());
	if (Array.isArray(body?.errors) && body!.errors.length) {
		throw new Error("GitHub GraphQL reconciliation failed");
	}
	const rate = object(object(body?.data)?.rateLimit);
	if (
		rate && Number(rate.remaining) === 0 &&
		Number.isFinite(Date.parse(string(rate.resetAt)))
	) throw new GitHubRateLimitError(Date.parse(string(rate.resetAt)));
	const repository = object(object(body?.data)?.repository);
	const connection = object(repository?.[cursor.kind]);
	const nodes = Array.isArray(connection?.nodes)
		? connection!.nodes.map(object).filter(Boolean) as Record<string, unknown>[]
		: [];
	const kind: ResourceKind = cursor.kind === "pullRequests"
		? "pullRequest"
		: cursor.kind === "discussions"
		? "discussion"
		: "issue";
	const projections = await Promise.all(nodes.flatMap((node) => {
		const author = object(node.author);
		return [
			githubProjection(identity.installationId, kind, node),
			...(author
				? [githubProjection(
					identity.installationId,
					ownerKind(author),
					{
						...author,
						id: author.id ?? author.databaseId ?? author.login,
					},
				)]
				: []),
		];
	}));
	const now = Date.now();
	const statements = projections.flatMap((projection) =>
		persist(
			db,
			projection,
			["user", "organization"].includes(projection.resourceType)
				? ""
				: cursor.repository_id,
			cursor.generation,
			now,
		)
	);
	const pageInfo = object(connection?.pageInfo);
	const hasNext = pageInfo?.hasNextPage === true;
	const endCursor = string(pageInfo?.endCursor, 2_000);
	if (hasNext && !endCursor) {
		throw new Error("GitHub returned an invalid cursor");
	}
	if (hasNext) {
		statements.push(
			db.prepare(
				"UPDATE github_sync_cursors SET cursor=?,updated_at=? WHERE kind=? AND repository_id=? AND generation=?",
			).bind(
				endCursor,
				now,
				cursor.kind,
				cursor.repository_id,
				cursor.generation,
			),
		);
	} else {
		const resourceType = kind;
		statements.push(
			db.prepare(
				`INSERT OR IGNORE INTO github_entity_projection_outbox
          (projection_id,resource_type,resource_id,source_revision,tag_id,label,
           aliases,"values",deleted,created_at)
         SELECT json_array('github', ?, resource_type, resource_id,
                  'deleted:' || source_revision),
                resource_type,resource_id,'deleted:' || source_revision,?,
                NULL,'[]',NULL,1,?
           FROM github_records
          WHERE repository_id=? AND resource_type=? AND active=1
            AND generation != ?`,
			).bind(
				identity.installationId,
				tagFor(resourceType),
				now,
				cursor.repository_id,
				resourceType,
				cursor.generation,
			),
			db.prepare(
				"UPDATE github_records SET active=0 WHERE repository_id=? AND resource_type=? AND generation != ?",
			).bind(cursor.repository_id, resourceType, cursor.generation),
			db.prepare(
				"UPDATE github_sync_cursors SET status='complete',cursor=NULL,updated_at=? WHERE kind=? AND repository_id=? AND generation=?",
			).bind(now, cursor.kind, cursor.repository_id, cursor.generation),
		);
	}
	await db.batch(statements);
};

/** Archive one bounded page after an installation is deleted. */
export const archiveInstallationPage = async (
	db: InstallationDatabase,
	identity: InstallationIdentity,
): Promise<{ pending: boolean }> => {
	const { results } = await db.prepare(
		"SELECT resource_type,resource_id FROM github_records WHERE active=1 ORDER BY resource_type,resource_id LIMIT ?",
	).bind(GITHUB_RECONCILE_PAGE_SIZE).all<{
		resource_type: ResourceKind;
		resource_id: string;
	}>();
	if (!results.length) return { pending: false };
	const statements: InstallationStatement[] = [];
	const now = Date.now();
	for (const row of results) {
		const projection = await githubProjection(
			identity.installationId,
			row.resource_type,
			{ id: row.resource_id },
			true,
		);
		statements.push(
			enqueue(db, projection, now),
			db.prepare(
				"UPDATE github_records SET active=0,source_revision=? WHERE resource_type=? AND resource_id=?",
			).bind(projection.sourceRevision, row.resource_type, row.resource_id),
		);
	}
	await db.batch(statements);
	const pending = await db.prepare(
		"SELECT 1 AS pending FROM github_records WHERE active=1 LIMIT 1",
	).first();
	return { pending: pending !== null };
};

export const reconcileInstallationPage = async (
	db: InstallationDatabase,
	env: GitHubEnv,
	identity: InstallationIdentity,
): Promise<{ pending: boolean }> => {
	const state = await db.prepare(
		"SELECT status,rate_limit_until FROM installation_state WHERE installation_id=? AND owner_id=?",
	).bind(identity.installationId, identity.ownerId).first<{
		status: string;
		rate_limit_until: number | null;
	}>();
	if (!state || state.status !== "active") return { pending: false };
	if (state.rate_limit_until && state.rate_limit_until > Date.now()) {
		throw new GitHubRateLimitError(state.rate_limit_until);
	}
	const cursor = await db.prepare(
		`SELECT kind,repository_id,cursor,generation
       FROM github_sync_cursors WHERE status='pending'
       ORDER BY CASE kind WHEN 'repositories' THEN 0 ELSE 1 END,kind,repository_id
       LIMIT 1`,
	).first<CursorRow>();
	if (!cursor) return { pending: false };
	const token = await installationAccessToken(env, identity.installationId);
	if (cursor.kind === "repositories") {
		await repositoryPage(db, env, identity, token, cursor);
	} else {
		await collectionPage(db, env, identity, token, cursor);
	}
	const pending = await db.prepare(
		"SELECT 1 AS pending FROM github_sync_cursors WHERE status='pending' LIMIT 1",
	).first();
	return { pending: pending !== null };
};
