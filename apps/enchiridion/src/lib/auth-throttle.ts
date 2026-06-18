import type { Env } from "./types";

interface AuthFailureRow {
	key_hash: string;
	failed_count: number;
	first_failed_at: string;
	last_failed_at: string;
	locked_until: string | null;
}

export interface PasswordAuthThrottleDecision {
	keyHash?: string;
	limited: boolean;
	retryAfterSeconds?: number;
}

const failureLimit = 5;
const failureWindowMs = 15 * 60 * 1000;
const lockDurationMs = 15 * 60 * 1000;

export async function checkPasswordAuthThrottle(
	env: Env,
	request: Request,
	nowMs = Date.now(),
): Promise<PasswordAuthThrottleDecision> {
	if (!shouldThrottleRequest(request)) {
		return { limited: false };
	}

	const keyHash = await passwordAuthKeyHash(request);
	const row = await readAuthFailure(env, keyHash);
	const retryAfterSeconds = retryAfterForRow(row, nowMs);
	if (retryAfterSeconds > 0) {
		return { keyHash, limited: true, retryAfterSeconds };
	}

	return { keyHash, limited: false };
}

export async function recordPasswordAuthFailure(
	env: Env,
	keyHash: string,
	nowMs = Date.now(),
): Promise<PasswordAuthThrottleDecision> {
	const row = await readAuthFailure(env, keyHash);
	const now = new Date(nowMs).toISOString();
	const lockExpired = row?.locked_until ? Date.parse(row.locked_until) <= nowMs : false;
	const lastFailedMs = row ? Date.parse(row.last_failed_at) : 0;
	const withinWindow = row && Number.isFinite(lastFailedMs) && nowMs - lastFailedMs <= failureWindowMs && !lockExpired;
	const failedCount = withinWindow ? row.failed_count + 1 : 1;
	const firstFailedAt = withinWindow ? row.first_failed_at : now;
	const lockedUntil = failedCount >= failureLimit ? new Date(nowMs + lockDurationMs).toISOString() : null;

	await env.DB.prepare(`
		INSERT INTO auth_failures (key_hash, failed_count, first_failed_at, last_failed_at, locked_until)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(key_hash) DO UPDATE SET
			failed_count = excluded.failed_count,
			first_failed_at = excluded.first_failed_at,
			last_failed_at = excluded.last_failed_at,
			locked_until = excluded.locked_until
	`).bind(keyHash, failedCount, firstFailedAt, now, lockedUntil).run();

	if (!lockedUntil) {
		return { keyHash, limited: false };
	}

	return {
		keyHash,
		limited: true,
		retryAfterSeconds: Math.ceil(lockDurationMs / 1000),
	};
}

export async function clearPasswordAuthFailures(env: Env, keyHash: string): Promise<void> {
	await env.DB.prepare("DELETE FROM auth_failures WHERE key_hash = ?").bind(keyHash).run();
}

export function passwordAuthThrottleResponse(retryAfterSeconds = Math.ceil(lockDurationMs / 1000)): Response {
	return new Response(JSON.stringify({ error: "Too many failed password attempts" }), {
		status: 429,
		headers: {
			"content-type": "application/json",
			"retry-after": String(retryAfterSeconds),
			"www-authenticate": 'Basic realm="Enchiridion", charset="UTF-8"',
		},
	});
}

function shouldThrottleRequest(request: Request): boolean {
	return hasBasicAuth(request) && !isLocalDevelopmentRequest(request);
}

function hasBasicAuth(request: Request): boolean {
	return request.headers.get("authorization")?.toLowerCase().startsWith("basic ") ?? false;
}

async function passwordAuthKeyHash(request: Request): Promise<string> {
	const clientKey = request.headers.get("cf-connecting-ip")?.trim() || "unknown-client";
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`enchiridion:password-auth:v1:${clientKey}`),
	);
	return base64UrlEncodeBytes(new Uint8Array(bytes));
}

async function readAuthFailure(env: Env, keyHash: string): Promise<AuthFailureRow | null> {
	return await env.DB.prepare("SELECT * FROM auth_failures WHERE key_hash = ?").bind(keyHash).first<AuthFailureRow>();
}

function retryAfterForRow(row: AuthFailureRow | null, nowMs: number): number {
	if (!row?.locked_until) {
		return 0;
	}

	const lockedUntilMs = Date.parse(row.locked_until);
	if (!Number.isFinite(lockedUntilMs) || lockedUntilMs <= nowMs) {
		return 0;
	}

	return Math.ceil((lockedUntilMs - nowMs) / 1000);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isLocalDevelopmentRequest(request: Request): boolean {
	const { hostname } = new URL(request.url);
	return hostname === "localhost"
		|| hostname === "127.0.0.1"
		|| hostname === "::1"
		|| hostname === "[::1]"
		|| hostname.endsWith(".localhost");
}
