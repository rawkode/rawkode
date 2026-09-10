import { getApp, listApps as queryApps } from "./apps.ts";
import { RpcTarget } from "capnweb";
import * as oauth from "oauth4webapi";
import type { CreateAppInput, OAuthAdminApi } from "@e2/oauth-client/contracts";
import type { OAuthEnv } from "./env.ts";
import { serviceCredentials, websiteOrigin } from "./env.ts";
import { createTokenVault, randomSecret, sha256 } from "./crypto.ts";
import {
	OAuthError,
	requireScopes,
	requireString,
	safeCall,
} from "./errors.ts";
import { github, google, provider } from "./providers.ts";
import {
	type AppRow,
	listConnections as queryConnections,
	publicApp,
} from "./store.ts";

export const createAdminApi = (
	env: OAuthEnv,
	ownerId: string,
): OAuthAdminApi => {
	const owner = requireString(ownerId, "account identity", 200);
	const getConfiguration = () => {
		return safeCall(() => ({
			providers: [google, github],
			serviceIds: Object.keys(serviceCredentials(env)).sort(),
			redirectOrigin: websiteOrigin(env),
		}));
	};

	const listApps = () => {
		return safeCall(async () => {
			const results = await queryApps(env);
			return results.map((row) => publicApp(row, env));
		});
	};

	const createApp = (input: CreateAppInput) => {
		return safeCall(async () => {
			if (!input || typeof input !== "object") {
				throw new OAuthError("Enter the OAuth app details.");
			}
			const name = requireString(input.name, "app name", 100);
			const p = provider(requireString(input.providerId, "provider"), env);
			const clientId = requireString(input.clientId, "client ID", 500);
			const secret = requireString(input.clientSecret, "client secret", 4096);
			const scopes = p.validateScopes(requireScopes(input.scopes));
			const id = crypto.randomUUID();
			const row: AppRow = {
				id,
				name,
				provider_id: p.definition.id,
				client_id: clientId,
				client_secret: await createTokenVault(env).encrypt(
					secret,
					`app:${id}:secret`,
				),
				scopes: JSON.stringify(scopes),
				created_at: Date.now(),
			};
			await env.DB.prepare(
				"INSERT INTO oauth_apps (id, name, provider_id, client_id, client_secret, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(
					row.id,
					row.name,
					row.provider_id,
					row.client_id,
					row.client_secret,
					row.scopes,
					row.created_at,
				).run();
			return publicApp(row, env);
		});
	};

	const listConnections = () => {
		return safeCall(() => queryConnections(env.DB, { ownerId: owner }));
	};

	const beginConnection = (
		input: { appId: string; browserBindingHash: string },
	) => {
		return safeCall(async () => {
			if (!input || !/^[a-f0-9]{64}$/.test(input.browserBindingHash)) {
				throw new OAuthError("Invalid browser binding.");
			}
			const app = await getApp(env, requireString(input.appId, "app ID"));
			if (!app) throw new OAuthError("OAuth app not found.");
			const p = provider(app.provider_id, env);
			const state = randomSecret();
			const stateId = await sha256(state);
			const verifier = oauth.generateRandomCodeVerifier();
			const nonce = oauth.generateRandomNonce();
			const url = new URL(p.server.authorization_endpoint!);
			url.search = new URLSearchParams({
				client_id: app.client_id,
				redirect_uri: p.redirectUri,
				response_type: "code",
				scope: JSON.parse(app.scopes).join(" "),
				state,
				code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
				code_challenge_method: "S256",
				...(app.provider_id === "google"
					? { nonce, access_type: "offline", prompt: "consent" }
					: {}),
			}).toString();
			await env.DB.prepare(
				"INSERT INTO oauth_sessions (state_hash, app_id, owner_id, browser_binding_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
				.bind(
					stateId,
					app.id,
					owner,
					input.browserBindingHash,
					await createTokenVault(env).encrypt(verifier, `session:${stateId}`),
					nonce,
					Date.now() + 600_000,
				).run();
			return { authorizationUrl: url.toString(), stateId };
		});
	};

	const owns = async (id: string) => {
		const row = await env.DB.prepare(
			"SELECT id FROM oauth_connections WHERE id = ? AND owner_id = ?",
		).bind(requireString(id, "connection ID"), owner).first();
		if (!row) throw new OAuthError("Connection not found.");
	};

	const disconnect = (connectionId: string) => {
		return safeCall(async () => {
			await owns(connectionId);
			// Deleting the row invalidates in-flight refresh writes and cascades all consumer grants.
			await env.DB.prepare(
				"DELETE FROM oauth_connections WHERE id = ? AND owner_id = ?",
			).bind(connectionId, owner).run();
		});
	};

	const grantService = (connectionId: string, serviceId: string) => {
		return safeCall(async () => {
			await owns(connectionId);
			if (!Object.hasOwn(serviceCredentials(env), serviceId)) {
				throw new OAuthError("Integration service not configured.");
			}
			await env.DB.prepare(
				"INSERT OR IGNORE INTO oauth_service_grants (connection_id, service_id, created_at) SELECT id, ?, ? FROM oauth_connections WHERE id = ? AND owner_id = ?",
			)
				.bind(serviceId, Date.now(), connectionId, owner).run();
		});
	};

	const revokeService = (connectionId: string, serviceId: string) => {
		return safeCall(async () => {
			await owns(connectionId);
			await env.DB.prepare(
				"DELETE FROM oauth_service_grants WHERE connection_id = ? AND service_id = ?",
			).bind(connectionId, requireString(serviceId, "service ID")).run();
		});
	};
	return {
		getConfiguration,
		listApps,
		createApp,
		listConnections,
		beginConnection,
		disconnect,
		grantService,
		revokeService,
	};
};

export class AdminApi extends RpcTarget implements OAuthAdminApi {
	#api: OAuthAdminApi;
	constructor(env: OAuthEnv, ownerId: string) {
		super();
		this.#api = createAdminApi(env, ownerId);
	}
	getConfiguration() {
		return this.#api.getConfiguration();
	}
	listApps() {
		return this.#api.listApps();
	}
	createApp(input: CreateAppInput) {
		return this.#api.createApp(input);
	}
	listConnections() {
		return this.#api.listConnections();
	}
	beginConnection(input: { appId: string; browserBindingHash: string }) {
		return this.#api.beginConnection(input);
	}
	disconnect(connectionId: string) {
		return this.#api.disconnect(connectionId);
	}
	grantService(connectionId: string, serviceId: string) {
		return this.#api.grantService(connectionId, serviceId);
	}
	revokeService(connectionId: string, serviceId: string) {
		return this.#api.revokeService(connectionId, serviceId);
	}
}
