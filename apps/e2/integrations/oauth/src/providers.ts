import * as oauth from "oauth4webapi";
import type { OAuthProvider } from "@e2/oauth-client/contracts";
import type { OAuthEnv } from "./env.ts";
import { websiteOrigin } from "./env.ts";
import { OAuthError } from "./errors.ts";

export const google: OAuthProvider = {
	id: "google",
	name: "Google",
	identityScopes: ["openid", "email"],
	presets: [
		{
			id: "google-workspace",
			name: "Google Workspace",
			description:
				"Sync contacts and calendars; search Gmail and receive mailbox notifications without mirroring email.",
			scopes: [
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/contacts.readonly",
				"https://www.googleapis.com/auth/gmail.readonly",
			],
		},
		{
			id: "google-contacts",
			name: "Google Contacts",
			description: "Sync saved contacts.",
			scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
		},
		{
			id: "google-calendar",
			name: "Google Calendar",
			description: "Read calendar events.",
			scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
		},
		{
			id: "google-mail",
			name: "Google Mail",
			description: "Read mail messages and labels.",
			scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
		},
		{
			id: "google-drive",
			name: "Google Drive",
			description: "Read files and their metadata.",
			scopes: ["https://www.googleapis.com/auth/drive.readonly"],
		},
	],
};

export const github: OAuthProvider = {
	id: "github",
	name: "GitHub",
	identityScopes: ["read:user"],
	presets: [
		{
			id: "github-repositories",
			name: "GitHub repositories",
			description:
				"Access public repositories and your profile. GitHub OAuth public_repo scope also permits writes.",
			scopes: ["public_repo"],
		},
		{
			id: "github-private-repositories",
			name: "GitHub private repositories",
			description:
				"Access private repositories. GitHub OAuth repo scope also permits writes.",
			scopes: ["repo"],
		},
	],
};

export const normalizeScopes = (scopes: string[]): string[] => {
	return [
		...new Set(
			scopes.map((scope) =>
				scope === "https://www.googleapis.com/auth/userinfo.email"
					? "email"
					: scope === "https://www.googleapis.com/auth/userinfo.profile"
					? "profile"
					: scope
			),
		),
	].sort();
};

export const provider = (id: string, env: OAuthEnv) => {
	if (id !== google.id && id !== github.id) {
		throw new OAuthError("This OAuth provider is not supported.");
	}
	const definition = id === "github" ? github : google;
	const local = env.LOCAL_PROVIDER_ORIGIN;
	if (local) {
		const url = new URL(local);
		if (
			!websiteOrigin(env).startsWith("http:") || url.origin !== local ||
			url.protocol !== "http:" ||
			!["localhost", "127.0.0.1"].includes(url.hostname)
		) {
			throw new Error(
				"The test provider is available only with loopback development origins.",
			);
		}
	}
	const server: oauth.AuthorizationServer = id === "github"
		? {
			issuer: local || "https://github.com",
			authorization_endpoint: local
				? `${local}/authorize/github`
				: "https://github.com/login/oauth/authorize",
			token_endpoint: local
				? `${local}/token/github`
				: "https://github.com/login/oauth/access_token",
		}
		: {
			issuer: local || "https://accounts.google.com",
			authorization_endpoint: local
				? `${local}/authorize`
				: "https://accounts.google.com/o/oauth2/v2/auth",
			token_endpoint: local
				? `${local}/token`
				: "https://oauth2.googleapis.com/token",
			userinfo_endpoint: local
				? `${local}/userinfo`
				: "https://openidconnect.googleapis.com/v1/userinfo",
			jwks_uri: local
				? `${local}/jwks`
				: "https://www.googleapis.com/oauth2/v3/certs",
		};
	const options = {
		signal: () => AbortSignal.timeout(10_000),
		[oauth.allowInsecureRequests]: Boolean(local),
	};
	return {
		definition,
		server,
		options,
		redirectUri: `${websiteOrigin(env)}/oauth/callback/${id}`,
		identityEndpoint: local
			? `${local}/user/github`
			: "https://api.github.com/user",
		validateScopes: (scopes: string[]) => {
			if (id === "github") {
				if (scopes.some((scope) => !/^[a-z][a-z0-9_:]*$/.test(scope))) {
					throw new OAuthError("Enter valid GitHub OAuth scopes.");
				}
				return normalizeScopes([...github.identityScopes, ...scopes]);
			}
			if (
				scopes.some((scope) =>
					!["openid", "email", "profile"].includes(scope) &&
					!/^https:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9._/-]+$/.test(
						scope,
					)
				)
			) {
				throw new OAuthError("Enter valid Google OAuth scopes.");
			}
			return normalizeScopes([...google.identityScopes, ...scopes]);
		},
	};
};

// GitHub discards narrower scopes covered by an umbrella scope when issuing tokens.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
const githubScopeCoverage: Readonly<Record<string, readonly string[]>> = {
	user: ["read:user", "user:email", "user:follow"],
	repo: [
		"public_repo",
		"repo:status",
		"repo_deployment",
		"repo:invite",
		"security_events",
		"admin:repo_hook",
		"write:repo_hook",
		"read:repo_hook",
	],
	"admin:repo_hook": ["write:repo_hook", "read:repo_hook"],
	"write:repo_hook": ["read:repo_hook"],
	"admin:org": ["write:org", "read:org"],
	"write:org": ["read:org"],
	"admin:public_key": ["write:public_key", "read:public_key"],
	"write:public_key": ["read:public_key"],
	"admin:gpg_key": ["write:gpg_key", "read:gpg_key"],
	"write:gpg_key": ["read:gpg_key"],
	project: ["read:project"],
};

/** Compare permissions without inventing scopes in stored or returned tokens. */
export const coversScopes = (
	providerId: string,
	granted: readonly string[],
	required: readonly string[],
): boolean =>
	required.every((scope) =>
		granted.some((grant) =>
			grant === scope ||
			(providerId === "github" && githubScopeCoverage[grant]?.includes(scope))
		)
	);
