import { appSecret, getApp } from "./apps.ts";
import * as oauth from "oauth4webapi";
import type { OAuthEnv } from "./env.ts";
import { websiteOrigin } from "./env.ts";
import { createTokenVault, sha256 } from "./crypto.ts";
import { coversScopes, normalizeScopes, provider } from "./providers.ts";
import type { ConnectionRow, SessionRow } from "./store.ts";

export const bindingCookieName = (stateId: string, secure: boolean): string => {
	return `${secure ? "__Host-" : ""}e2-oauth-${stateId.slice(0, 24)}`;
};

const failureDetails = (error: unknown): Record<string, unknown> => {
	if (!(error instanceof Error)) return { type: typeof error };
	if (error instanceof oauth.ResponseBodyError) {
		return {
			type: error.name,
			status: error.status,
			providerError: error.error,
		};
	}
	if (error instanceof oauth.AuthorizationResponseError) {
		return { type: error.name, providerError: error.error };
	}
	return { type: error.name };
};

export const callback = async (
	request: Request,
	env: OAuthEnv,
): Promise<Response> => {
	const url = new URL(request.url);
	const origin = websiteOrigin(env);
	const state = url.searchParams.get("state");
	if (
		!state || !/^[A-Za-z0-9_-]{43}$/.test(state) ||
		url.searchParams.getAll("state").length !== 1
	) {
		return new Response(
			"Invalid OAuth state. Start again from the admin interface.",
			{ status: 400 },
		);
	}
	const stateId = await sha256(state);
	const secure = origin.startsWith("https:");
	const cookieName = bindingCookieName(stateId, secure);
	const cookies = (request.headers.get("Cookie") || "").split(";").map((v) =>
		v.trim()
	);
	const matches = cookies.filter((cookie) =>
		cookie.startsWith(`${cookieName}=`)
	);
	const binding = matches.length === 1
		? matches[0].slice(cookieName.length + 1)
		: "";
	if (!/^[A-Za-z0-9_-]{43}$/.test(binding)) {
		return new Response(
			"This connection was started in another browser, or has expired.",
			{ status: 400 },
		);
	}
	const browserHash = await sha256(binding);
	// Atomic consume only after verifying browser, expiry, and provider route. Replays never reach the provider.
	const session = await env.DB.prepare(
		`DELETE FROM oauth_sessions WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
    AND app_id IN (SELECT id FROM oauth_apps WHERE provider_id = ?) RETURNING *`,
	)
		.bind(stateId, browserHash, Date.now(), url.pathname.split("/").at(-1))
		.first<SessionRow>();
	if (!session) {
		return new Response(
			"This connection has expired or was already completed. Start again.",
			{ status: 400 },
		);
	}

	let result = "failed";
	let providerId = "unknown";
	try {
		const app = await getApp(env, session.app_id);
		if (!app) throw new Error("App missing.");
		providerId = app.provider_id;
		const p = provider(app.provider_id, env);
		const vault = createTokenVault(env);
		const client: oauth.Client = { client_id: app.client_id };
		const parameters = oauth.validateAuthResponse(p.server, client, url, state);
		const response = await oauth.authorizationCodeGrantRequest(
			p.server,
			client,
			oauth.ClientSecretPost(
				await appSecret(env, app),
			),
			parameters,
			p.redirectUri,
			await vault.decrypt(session.verifier, `session:${stateId}`),
			p.options,
		);
		const tokens = await oauth.processAuthorizationCodeResponse(
			p.server,
			client,
			response,
			app.provider_id === "google"
				? { expectedNonce: session.nonce, requireIdToken: true }
				: {},
		);
		const identity = await readIdentity(p, client, tokens);
		const scopes = normalizeScopes(
			tokens.scope?.split(/[ ,]+/).filter(Boolean) ?? JSON.parse(app.scopes),
		);
		const requested: string[] = JSON.parse(app.scopes);
		if (
			(app.provider_id === "google"
				? JSON.stringify(scopes) !== app.scopes
				: !coversScopes(app.provider_id, scopes, requested)) ||
			tokens.token_type !== "bearer" ||
			(tokens.expires_in !== undefined &&
				(!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) ||
			(app.provider_id === "google" && tokens.expires_in === undefined)
		) {
			result = "scopes";
			throw new Error("Unexpected token permissions or lifetime.");
		}
		const old = await env.DB.prepare(
			"SELECT * FROM oauth_connections WHERE app_id = ? AND owner_id = ? AND account_id = ?",
		)
			.bind(app.id, session.owner_id, identity.id).first<ConnectionRow>();
		if (
			tokens.expires_in !== undefined && !tokens.refresh_token &&
			!old?.refresh_token
		) {
			result = "offline";
			throw new Error("Offline access required.");
		}
		const id = old?.id ?? crypto.randomUUID();
		const access = await vault.encrypt(
			tokens.access_token,
			`connection:${id}:access`,
		);
		const refresh = tokens.refresh_token
			? await vault.encrypt(tokens.refresh_token, `connection:${id}:refresh`)
			: old?.refresh_token ?? null;
		const label = identity.label;
		const expires = tokens.expires_in === undefined
			? null
			: Date.now() + tokens.expires_in * 1000;
		if (old) {
			const update = await env.DB.prepare(
				`UPDATE oauth_connections SET account_label = ?, scopes = ?, access_token = ?, refresh_token = ?, expires_at = ?,
        status = 'connected', version = version + 1, grant_version = grant_version + 1, refresh_lease = NULL, refresh_lease_until = NULL WHERE id = ? AND version = ?`,
			)
				.bind(
					label,
					JSON.stringify(scopes),
					access,
					refresh,
					expires,
					id,
					old.version,
				).run();
			if (update.meta.changes !== 1) {
				throw new Error("Connection changed during authorization.");
			}
		} else {
			await env.DB.prepare(
				`INSERT INTO oauth_connections (id, app_id, owner_id, account_id, account_label, scopes, access_token, refresh_token, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					id,
					app.id,
					session.owner_id,
					identity.id,
					label,
					JSON.stringify(scopes),
					access,
					refresh,
					expires,
					Date.now(),
				).run();
		}
		result = "connected";
	} catch (error) {
		if (url.searchParams.get("error") === "access_denied") result = "cancelled";
		// Never expose provider errors, authorization codes, tokens, or client secrets.
		console.error("OAuth callback failed", {
			provider: providerId,
			...failureDetails(error),
		});
	}
	return new Response(null, {
		status: 303,
		headers: {
			Location: `${origin}/admin/oauth?result=${result}`,
			"Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${
				secure ? "; Secure" : ""
			}`,
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
};

const readIdentity = async (
	p: ReturnType<typeof provider>,
	client: oauth.Client,
	tokens: oauth.TokenEndpointResponse,
) => {
	if (p.definition.id === "github") {
		const response = await fetch(p.identityEndpoint, {
			headers: {
				Authorization: `Bearer ${tokens.access_token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "e2-integrations-oauth",
			},
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("GitHub identity lookup failed.");
		const user = await response.json() as { id?: unknown; login?: unknown };
		if (
			!Number.isSafeInteger(user.id) || (user.id as number) <= 0 ||
			typeof user.login !== "string" || !user.login
		) throw new Error("Invalid GitHub identity.");
		return { id: String(user.id), label: user.login };
	}
	const claims = oauth.getValidatedIdTokenClaims(tokens)!;
	const response = await oauth.userInfoRequest(
		p.server,
		client,
		tokens.access_token,
		p.options,
	);
	const user = await oauth.processUserInfoResponse(
		p.server,
		client,
		claims.sub,
		response,
	);
	return {
		id: claims.sub,
		label: typeof user.email === "string" && user.email_verified === true
			? user.email
			: claims.sub,
	};
};
