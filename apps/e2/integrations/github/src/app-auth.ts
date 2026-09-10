import { importPKCS8, SignJWT } from "jose";
import type { GitHubEnv } from "./env.ts";

export const GITHUB_APP_PERMISSIONS = {
	metadata: "read",
	issues: "read",
	pull_requests: "read",
	discussions: "read",
} as const;

export class GitHubRateLimitError extends Error {
	constructor(readonly retryAt: number) {
		super("GitHub App rate limit reached");
	}
}

export const githubAppConfigured = (
	env: GitHubEnv,
): env is GitHubEnv & {
	DB: D1Database;
	GITHUB_INSTALLATIONS: NonNullable<GitHubEnv["GITHUB_INSTALLATIONS"]>;
	ENTITIES_ADMIN: NonNullable<GitHubEnv["ENTITIES_ADMIN"]>;
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: NonNullable<GitHubEnv["GITHUB_APP_PRIVATE_KEY"]>;
	GITHUB_WEBHOOK_SECRET: NonNullable<GitHubEnv["GITHUB_WEBHOOK_SECRET"]>;
} =>
	Boolean(
		env.DB && env.GITHUB_INSTALLATIONS && env.ENTITIES_ADMIN &&
			env.GITHUB_APP_ID &&
			env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET,
	);

const apiOrigin = (env: GitHubEnv): string => {
	if (!env.GITHUB_API_ORIGIN) return "https://api.github.com";
	const url = new URL(env.GITHUB_API_ORIGIN);
	if (
		url.origin !== env.GITHUB_API_ORIGIN || url.protocol !== "http:" ||
		!["localhost", "127.0.0.1"].includes(url.hostname)
	) throw new Error("The GitHub test API must be an HTTP loopback origin");
	return url.origin;
};

const hex = (bytes: Uint8Array): string =>
	[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string): Uint8Array | null => {
	if (!/^[a-f0-9]{64}$/i.test(value)) return null;
	return new Uint8Array(value.match(/../g)!.map((part) => parseInt(part, 16)));
};

/** Read and authenticate the exact bytes before attempting JSON parsing. */
export const verifyGitHubWebhook = async (
	request: Request,
	secret: string,
): Promise<{
	deliveryId: string;
	event: string;
	payload: Record<string, unknown>;
}> => {
	if (request.method !== "POST") throw new Error("Method not allowed");
	const length = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(length) && length > 1024 * 1024) {
		throw new Error("Webhook body is too large");
	}
	const body = new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > 1024 * 1024) {
		throw new Error("Webhook body is too large");
	}
	const supplied = request.headers.get("X-Hub-Signature-256") ?? "";
	const signature = supplied.startsWith("sha256=")
		? fromHex(supplied.slice(7))
		: null;
	if (!signature || !secret || secret.length > 4096) {
		throw new Error("Invalid webhook signature");
	}
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	if (
		!await crypto.subtle.verify("HMAC", key, signature as BufferSource, body)
	) throw new Error("Invalid webhook signature");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
	} catch {
		throw new Error("Invalid webhook payload");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid webhook payload");
	}
	const deliveryId = request.headers.get("X-GitHub-Delivery") ?? "";
	const event = request.headers.get("X-GitHub-Event") ?? "";
	if (
		!/^[0-9a-f-]{16,64}$/i.test(deliveryId) ||
		!/^[a-z_]{1,100}$/.test(event)
	) throw new Error("Invalid webhook headers");
	return { deliveryId, event, payload: value as Record<string, unknown> };
};

const appJwt = async (env: GitHubEnv): Promise<string> => {
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
		throw new Error("GitHub App is not configured");
	}
	const pem = (await env.GITHUB_APP_PRIVATE_KEY.get()).replaceAll("\\n", "\n");
	const key = await importPKCS8(pem, "RS256");
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(env.GITHUB_APP_ID)
		.setIssuedAt(now - 60)
		.setExpirationTime(now + 540)
		.sign(key);
};

const retryAt = (response: Response): number => {
	const retry = Number(response.headers.get("Retry-After"));
	if (Number.isFinite(retry) && retry > 0) return Date.now() + retry * 1000;
	const reset = Number(response.headers.get("X-RateLimit-Reset"));
	if (Number.isFinite(reset) && reset > 0) return reset * 1000;
	return Date.now() + 60_000;
};

export const githubRequest = async (
	env: GitHubEnv,
	path: string,
	init: RequestInit,
): Promise<Response> => {
	const response = await fetch(new URL(path, apiOrigin(env)), {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "e2-integrations-github-app",
			...Object.fromEntries(new Headers(init.headers).entries()),
		},
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 403 || response.status === 429) {
		await response.body?.cancel();
		throw new GitHubRateLimitError(retryAt(response));
	}
	return response;
};

export const readGitHubInstallation = async (
	env: GitHubEnv,
	installationId: string,
): Promise<Record<string, unknown>> => {
	if (!/^[1-9]\d{0,31}$/.test(installationId)) {
		throw new Error("Invalid GitHub installation ID");
	}
	const response = await githubRequest(
		env,
		`/app/installations/${installationId}`,
		{
			headers: { Authorization: `Bearer ${await appJwt(env)}` },
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("GitHub App installation is unavailable");
	}
	const value: unknown = await response.json();
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("GitHub returned an invalid installation");
	}
	return value as Record<string, unknown>;
};

export const assertReadOnlyPermissions = (
	value: unknown,
): void => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("GitHub App permissions are unavailable");
	}
	const permissions = value as Record<string, unknown>;
	for (const [name, permission] of Object.entries(permissions)) {
		if (!["read", "none"].includes(String(permission))) {
			throw new Error(`GitHub App ${name} permission must be read-only`);
		}
	}
	for (const [name, expected] of Object.entries(GITHUB_APP_PERMISSIONS)) {
		if (permissions[name] !== expected) {
			throw new Error(`GitHub App requires ${name} read permission`);
		}
	}
	if (permissions.contents && permissions.contents !== "none") {
		throw new Error("GitHub App Contents permission must be disabled");
	}
};

export const installationAccessToken = async (
	env: GitHubEnv,
	installationId: string,
): Promise<string> => {
	const { metadata: _metadata, ...permissions } = GITHUB_APP_PERMISSIONS;
	const response = await githubRequest(
		env,
		`/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${await appJwt(env)}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ permissions }),
		},
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error("GitHub App installation token is unavailable");
	}
	const value: unknown = await response.json();
	const token = value && typeof value === "object"
		? (value as Record<string, unknown>).token
		: undefined;
	if (typeof token !== "string" || !token || token.length > 4096) {
		throw new Error("GitHub returned an invalid installation token");
	}
	return token;
};

export const sha256 = async (value: string): Promise<string> =>
	hex(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
