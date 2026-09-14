import { appSecret, getApp } from "./apps.ts";
import { RpcTarget } from "capnweb";
import * as oauth from "oauth4webapi";
import type {
	AccessToken,
	OAuthIntegrationApi,
} from "@e2/oauth-client/contracts";
import type { OAuthEnv } from "./env.ts";
import { serviceCredentials } from "./env.ts";
import { createTokenVault, sha256 } from "./crypto.ts";
import {
	OAuthError,
	requireScopes,
	requireString,
	safeCall,
} from "./errors.ts";
import { coversScopes, normalizeScopes, provider } from "./providers.ts";
import {
	type ConnectionRow,
	listConnections as queryConnections,
} from "./store.ts";

export const authenticateService = async (
	env: OAuthEnv,
	credential: string,
): Promise<string> => {
	if (
		typeof credential !== "string" || credential.length < 32 ||
		credential.length > 256
	) throw new OAuthError("Unauthorized integration.");
	const hash = await sha256(credential);
	const services = await Promise.all(
		Object.entries(serviceCredentials(env)).map(async ([id, binding]) => {
			const secret = await binding.get();
			if (
				typeof secret !== "string" || secret.length < 32 || secret.length > 256
			) throw new OAuthError("Unauthorized integration.");
			return [id, await sha256(secret)] as const;
		}),
	);
	const service = services.find(([, expected]) => expected === hash)?.[0];
	if (!service) throw new OAuthError("Unauthorized integration.");
	return service;
};

export const createIntegrationApi = (
	env: OAuthEnv,
	credential: string,
): OAuthIntegrationApi => {
	const listConnections = () => {
		return safeCall(async () =>
			queryConnections(env.DB, {
				serviceId: await authenticateService(env, credential),
			})
		);
	};

	const getConnectionForCleanup = (connectionId: string, ownerId: string) =>
		safeCall(async () => {
			const service = await authenticateService(env, credential);
			const id = requireString(connectionId, "connection ID");
			const owner = requireString(ownerId, "account identity", 200);
			const providerId = service === "integrations-google"
				? "google"
				: service === "integrations-github"
				? "github"
				: undefined;
			if (!providerId) throw new OAuthError("Unauthorized integration.");
			const row = await env.DB.prepare(
				`SELECT c.id, c.owner_id, c.grant_version, a.provider_id FROM oauth_connections c JOIN oauth_apps a ON a.id = c.app_id
      WHERE c.id = ? AND c.owner_id = ? AND a.provider_id = ?`,
			).bind(id, owner, providerId).first<
				Pick<ConnectionRow, "id" | "owner_id" | "grant_version"> & {
					provider_id: string;
				}
			>();
			if (await authenticateService(env, credential) !== service) {
				throw new OAuthError("Unauthorized integration.");
			}
			return row
				? {
					id: row.id,
					ownerId: row.owner_id,
					providerId: row.provider_id,
					grantVersion: row.grant_version,
				}
				: null;
		});

	const canDeleteConnection = (connectionId: string, ownerId: string) =>
		getConnectionForCleanup(connectionId, ownerId).then((row) => row !== null);

	const getAccessToken = (connectionId: string, requiredScopes: string[]) => {
		return safeCall(async () => {
			const service = await authenticateService(env, credential);
			const id = requireString(connectionId, "connection ID");
			const scopes = normalizeScopes(requireScopes(requiredScopes));
			for (let attempt = 0; attempt < 30; attempt++) {
				const row = await authorized(id, service);
				if (!coversScopes(row.provider_id, JSON.parse(row.scopes), scopes)) {
					throw new OAuthError(
						"The connected account has not granted the required scopes.",
					);
				}
				if (row.status !== "connected" || !row.access_token) {
					throw new OAuthError(
						"Reconnect this account before requesting a token.",
					);
				}
				if (row.expires_at === null || row.expires_at > Date.now() + 60_000) {
					return token(row, service);
				}
				if (!row.refresh_token) {
					throw new OAuthError(
						"Reconnect this account before requesting a token.",
					);
				}
				const lease = crypto.randomUUID();
				const acquired = await env.DB.prepare(
					`UPDATE oauth_connections SET refresh_lease = ?, refresh_lease_until = ?
          WHERE id = ? AND version = ? AND (refresh_lease_until IS NULL OR refresh_lease_until < ?) RETURNING id`,
				)
					.bind(lease, Date.now() + 30_000, id, row.version, Date.now())
					.first();
				if (acquired) return refresh(row, lease, service, scopes);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new OAuthError("Token refresh is in progress. Retry shortly.");
		});
	};

	const authorized = async (
		id: string,
		service: string,
	): Promise<ConnectionRow & { provider_id: string }> => {
		const row = await env.DB.prepare(
			`SELECT c.*, a.provider_id FROM oauth_connections c JOIN oauth_apps a ON a.id = c.app_id JOIN oauth_service_grants g ON g.connection_id = c.id
      WHERE c.id = ? AND g.service_id = ?`,
		).bind(id, service).first<ConnectionRow & { provider_id: string }>();
		if (!row) {
			throw new OAuthError(
				"This integration is not authorized for the connection.",
			);
		}
		return row;
	};

	const token = async (
		row: ConnectionRow,
		service: string,
	): Promise<AccessToken> => {
		const current = await authorized(row.id, service);
		if (
			current.version !== row.version || !current.access_token ||
			current.status !== "connected"
		) throw new OAuthError("Connection changed. Retry the token request.");
		const accessToken = await createTokenVault(env).decrypt(
			current.access_token,
			`connection:${row.id}:access`,
		);
		if (await authenticateService(env, credential) !== service) {
			throw new OAuthError("Unauthorized integration.");
		}
		return {
			accessToken,
			expiresAt: current.expires_at,
			tokenType: "Bearer",
			scopes: JSON.parse(current.scopes),
		};
	};

	const refresh = async (
		row: ConnectionRow,
		lease: string,
		service: string,
		required: string[],
	): Promise<AccessToken> => {
		const db = env.DB;
		const vault = createTokenVault(env);
		try {
			const app = await getApp(env, row.app_id);
			if (!app) throw new OAuthError("OAuth app not found.");
			const p = provider(app.provider_id, env);
			const client = { client_id: app.client_id };
			const response = await oauth.refreshTokenGrantRequest(
				p.server,
				client,
				oauth.ClientSecretPost(
					await appSecret(env, app),
				),
				await vault.decrypt(row.refresh_token!, `connection:${row.id}:refresh`),
				p.options,
			);
			const tokens = await oauth.processRefreshTokenResponse(
				p.server,
				client,
				response,
			);
			const scopes = normalizeScopes(
				tokens.scope?.split(/[ ,]+/).filter(Boolean) ?? JSON.parse(row.scopes),
			);
			if (
				(app.provider_id === "google"
					? JSON.stringify(scopes) !== row.scopes
					: !coversScopes(app.provider_id, scopes, JSON.parse(row.scopes)) ||
						!coversScopes(app.provider_id, JSON.parse(row.scopes), scopes)) ||
				!coversScopes(app.provider_id, scopes, required) ||
				tokens.token_type !== "bearer" || !tokens.expires_in ||
				tokens.expires_in <= 0
			) {
				await invalidate(row, lease);
				throw new OAuthError(
					"Account permissions changed. Reconnect the account.",
				);
			}
			const access = await vault.encrypt(
				tokens.access_token,
				`connection:${row.id}:access`,
			);
			const refresh = tokens.refresh_token
				? await vault.encrypt(
					tokens.refresh_token,
					`connection:${row.id}:refresh`,
				)
				: row.refresh_token;
			const updated = await db.prepare(
				`UPDATE oauth_connections SET access_token = ?, refresh_token = ?, expires_at = ?, version = version + 1,
        refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ? AND refresh_lease_until > ? RETURNING *`,
			)
				.bind(
					access,
					refresh,
					Date.now() + tokens.expires_in * 1000,
					row.id,
					row.version,
					lease,
					Date.now(),
				).first<ConnectionRow>();
			if (!updated) {
				throw new OAuthError(
					"Connection changed during refresh. Retry the token request.",
				);
			}
			return token(updated, service);
		} catch (error) {
			if (
				error instanceof oauth.ResponseBodyError &&
				error.error === "invalid_grant"
			) {
				await invalidate(row, lease);
				throw new OAuthError(
					"Provider access has expired or was revoked. Reconnect the account.",
				);
			}
			throw error;
		} finally {
			await db.prepare(
				"UPDATE oauth_connections SET refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ?",
			)
				.bind(row.id, row.version, lease).run();
		}
	};

	const invalidate = async (row: ConnectionRow, lease: string) => {
		await env.DB.prepare(
			`UPDATE oauth_connections SET status = 'reconnect_required', access_token = NULL, refresh_token = NULL,
      version = version + 1, refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ? AND refresh_lease = ?`,
		)
			.bind(row.id, row.version, lease).run();
	};
	return {
		listConnections,
		getAccessToken,
		canDeleteConnection,
		getConnectionForCleanup,
	};
};

export class IntegrationApi extends RpcTarget implements OAuthIntegrationApi {
	#api: OAuthIntegrationApi;
	constructor(env: OAuthEnv, credential: string) {
		super();
		this.#api = createIntegrationApi(env, credential);
	}
	listConnections() {
		return this.#api.listConnections();
	}
	canDeleteConnection(connectionId: string, ownerId: string) {
		return this.#api.canDeleteConnection(connectionId, ownerId);
	}
	getConnectionForCleanup(connectionId: string, ownerId: string) {
		return this.#api.getConnectionForCleanup(connectionId, ownerId);
	}

	getAccessToken(connectionId: string, requiredScopes: string[]) {
		return this.#api.getAccessToken(connectionId, requiredScopes);
	}
}
