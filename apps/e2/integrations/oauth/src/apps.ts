import type { OAuthEnv } from "./env.ts";
import { createTokenVault } from "./crypto.ts";
import { OAuthError, requireString } from "./errors.ts";
import { provider } from "./providers.ts";
import type { AppRow } from "./store.ts";

const managedGoogleApp = async (env: OAuthEnv): Promise<AppRow | null> => {
	if (!env.GOOGLE_CLIENT_ID && !env.GOOGLE_CLIENT_SECRET) return null;
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new OAuthError(
			"Google OAuth credentials are not configured together.",
		);
	}
	const clientId = requireString(
		await env.GOOGLE_CLIENT_ID.get(),
		"Google client ID",
		500,
	);
	const scopes = provider("google", env).validateScopes([
		"profile",
		"https://www.googleapis.com/auth/calendar.readonly",
		"https://www.googleapis.com/auth/contacts.readonly",
		"https://www.googleapis.com/auth/contacts.other.readonly",
		"https://www.googleapis.com/auth/directory.readonly",
		"https://www.googleapis.com/auth/gmail.readonly",
	]);
	// Metadata preserves foreign keys; the managed client secret stays in Secrets Store.
	await env.DB.prepare(
		"INSERT OR IGNORE INTO oauth_apps (id, name, provider_id, client_id, client_secret, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).bind(
		"google",
		"Google Workspace",
		"google",
		clientId,
		"",
		JSON.stringify(scopes),
		Date.now(),
	).run();
	const row = await env.DB.prepare("SELECT * FROM oauth_apps WHERE id = ?")
		.bind("google").first<AppRow>();
	if (
		!row || row.provider_id !== "google" || row.client_id !== clientId ||
		row.client_secret !== ""
	) {
		throw new OAuthError(
			"The managed Google OAuth app identity changed. Restore its original client ID.",
		);
	}
	const updated = {
		...row,
		name: "Google Workspace",
		scopes: JSON.stringify(scopes),
	};
	if (row.scopes !== updated.scopes || row.name !== updated.name) {
		await env.DB.prepare(
			"UPDATE oauth_apps SET name = ?, scopes = ? WHERE id = ? AND client_id = ?",
		).bind(updated.name, updated.scopes, row.id, clientId).run();
	}
	return updated;
};

const managedGithubApp = async (env: OAuthEnv): Promise<AppRow | null> => {
	const configuredClientId = env.GITHUB_CLIENT_ID
		? await env.GITHUB_CLIENT_ID.get()
		: "";
	const configuredClientSecret = env.GITHUB_CLIENT_SECRET
		? await env.GITHUB_CLIENT_SECRET.get()
		: "";
	if (!configuredClientId && !configuredClientSecret) return null;
	if (!configuredClientId || !configuredClientSecret) {
		throw new OAuthError(
			"GitHub OAuth credentials are not configured together.",
		);
	}
	const clientId = requireString(configuredClientId, "GitHub client ID", 500);
	const scopes = provider("github", env).validateScopes(["user:email"]);
	await env.DB.prepare(
		"INSERT OR IGNORE INTO oauth_apps (id, name, provider_id, client_id, client_secret, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).bind(
		"github",
		"GitHub",
		"github",
		clientId,
		"",
		JSON.stringify(scopes),
		Date.now(),
	).run();
	const row = await env.DB.prepare("SELECT * FROM oauth_apps WHERE id = ?")
		.bind("github").first<AppRow>();
	if (
		!row || row.provider_id !== "github" || row.client_id !== clientId ||
		row.client_secret !== ""
	) throw new OAuthError("The managed GitHub OAuth app identity changed.");
	const updated = { ...row, name: "GitHub", scopes: JSON.stringify(scopes) };
	if (row.scopes !== updated.scopes || row.name !== updated.name) {
		await env.DB.prepare(
			"UPDATE oauth_apps SET name = ?, scopes = ? WHERE id = ? AND client_id = ?",
		).bind(updated.name, updated.scopes, row.id, clientId).run();
	}
	return updated;
};

export const listApps = async (env: OAuthEnv): Promise<AppRow[]> => {
	const managed = await managedGoogleApp(env);
	const managedGithub = await managedGithubApp(env);
	const { results } = await env.DB.prepare(
		"SELECT * FROM oauth_apps ORDER BY created_at DESC, id",
	).all<AppRow>();
	return results.filter((row) =>
		(row.id !== "google" || managed !== null) &&
		(row.id !== "github" || managedGithub !== null)
	);
};

export const getApp = async (
	env: OAuthEnv,
	id: string,
): Promise<AppRow | null> =>
	id === "google"
		? await managedGoogleApp(env)
		: id === "github"
		? await managedGithubApp(env)
		: await env.DB.prepare("SELECT * FROM oauth_apps WHERE id = ?").bind(id)
			.first<AppRow>();

export const appSecret = async (
	env: OAuthEnv,
	app: AppRow,
): Promise<string> => {
	if (app.id !== "google" && app.id !== "github") {
		return createTokenVault(env).decrypt(
			app.client_secret,
			`app:${app.id}:secret`,
		);
	}
	const current = app.id === "github"
		? await managedGithubApp(env)
		: await managedGoogleApp(env);
	if (
		!current || current.client_id !== app.client_id ||
		(app.id === "github"
			? !env.GITHUB_CLIENT_SECRET
			: !env.GOOGLE_CLIENT_SECRET)
	) {
		throw new OAuthError(
			`The managed ${
				app.id === "github" ? "GitHub" : "Google"
			} OAuth app is unavailable.`,
		);
	}
	return requireString(
		await (app.id === "github"
			? env.GITHUB_CLIENT_SECRET!
			: env.GOOGLE_CLIENT_SECRET!).get(),
		`${app.id === "github" ? "GitHub" : "Google"} client secret`,
		4096,
	);
};
