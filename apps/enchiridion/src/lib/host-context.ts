import type { Env, JsonObject } from "./types";

export interface HostContextPayload {
	app: string;
	scopes: string[];
	expiresAt: number;
	context: JsonObject;
}

const schedulerApp = "__scheduler";
const schedulerHeader = "x-enchiridion-scheduler";

export function requireHostSigningSecret(env: Env, request?: Request): string {
	if (env.HOST_SIGNING_SECRET) {
		return env.HOST_SIGNING_SECRET;
	}

	if (request && isLocalDevelopmentRequest(request)) {
		return "dev-host-signing-secret";
	}

	throw new Response(JSON.stringify({ error: "HOST_SIGNING_SECRET is not configured" }), {
		status: 500,
		headers: { "content-type": "application/json" },
	});
}

export async function signHostContext(payload: HostContextPayload, secret: string): Promise<string> {
	const body = base64UrlEncode(JSON.stringify(payload));
	const signature = await hmacSha256(body, secret);
	return `${body}.${signature}`;
}

export async function verifyHostContext(token: string, secret: string): Promise<HostContextPayload | null> {
	const [body, signature] = token.split(".");
	if (!body || !signature) {
		return null;
	}

	const expected = await hmacSha256(body, secret);
	if (!constantTimeEqual(signature, expected)) {
		return null;
	}

	let payload: HostContextPayload;
	try {
		payload = JSON.parse(base64UrlDecode(body)) as HostContextPayload;
	} catch {
		return null;
	}

	if (!isHostContextPayload(payload)) {
		return null;
	}

	if (payload.expiresAt < Date.now()) {
		return null;
	}

	return payload;
}

export async function requireHostApiContext(env: Env, request: Request, requiredScope: string): Promise<HostContextPayload> {
	const token = request.headers.get("x-enchiridion-host-context");
	if (!token) {
		throw hostContextResponse("Missing host context token", 401);
	}

	const secret = requireHostSigningSecret(env, request);
	const payload = await verifyHostContext(token, secret);
	if (!payload) {
		throw hostContextResponse("Invalid or expired host context token", 401);
	}

	if (!payload.scopes.includes(requiredScope)) {
		throw hostContextResponse(`Host context token is missing required scope ${requiredScope}`, 403);
	}

	if (!isHostContextPathForApp(payload.context, payload.app)) {
		throw hostContextResponse("Host context token path is outside app route scope", 403);
	}

	return payload;
}

export async function signSchedulerWorkflowRequest(input: {
	path: string;
	scheduledAt: string;
	secret: string;
}): Promise<string> {
	return signHostContext({
		app: schedulerApp,
		scopes: ["workflows:run"],
		expiresAt: Date.now() + 60 * 1000,
		context: {
			path: input.path,
			scheduledAt: input.scheduledAt,
		},
	}, input.secret);
}

export async function isTrustedSchedulerWorkflowRequest(env: Env, request: Request): Promise<boolean> {
	const token = request.headers.get(schedulerHeader);
	if (!token) {
		return false;
	}

	let secret: string;
	try {
		secret = requireHostSigningSecret(env, request);
	} catch {
		return false;
	}
	const payload = await verifyHostContext(token, secret);
	if (!payload) {
		return false;
	}

	const path = payload.context.path;
	const requestPath = new URL(request.url).pathname;
	return payload.app === schedulerApp
		&& payload.scopes.includes("workflows:run")
		&& typeof path === "string"
		&& path === requestPath
		&& requestPath.startsWith("/api/flue/workflows/");
}

export function isHostContextPathForApp(context: JsonObject, app: string): boolean {
	const path = context.path;
	if (typeof path !== "string") {
		return false;
	}

	const base = `/apps/${app}`;
	return path === base || path.startsWith(`${base}/`);
}

async function hmacSha256(value: string, secret: string): Promise<string> {
	const keyMaterial = `enchiridion:host-context:v1:${secret}`;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(keyMaterial),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncode(value: string): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	return atob(padded);
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let diff = 0;
	for (let index = 0; index < a.length; index += 1) {
		diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return diff === 0;
}

function hostContextResponse(error: string, status: number): Response {
	return new Response(JSON.stringify({ error }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function isHostContextPayload(value: unknown): value is HostContextPayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const payload = value as HostContextPayload;
	return typeof payload.app === "string"
		&& Array.isArray(payload.scopes)
		&& payload.scopes.every((scope) => typeof scope === "string")
		&& typeof payload.expiresAt === "number"
		&& Boolean(payload.context)
		&& typeof payload.context === "object"
		&& !Array.isArray(payload.context);
}

function isLocalDevelopmentRequest(request: Request): boolean {
	const { hostname } = new URL(request.url);
	return hostname === "localhost"
		|| hostname === "127.0.0.1"
		|| hostname === "::1"
		|| hostname === "[::1]"
		|| hostname.endsWith(".localhost");
}
