import type { Env, ExtensionBinding, ExtensionManifest } from "./types";
import { requireHostSigningSecret, signHostContext } from "./host-context";

type UploadBindingMetadata =
	| { type: "kv_namespace"; name: string; namespace_id: string }
	| { type: "d1"; name: string; database_id: string }
	| { type: "r2_bucket"; name: string; bucket_name: string };

export interface DeployMiniAppInput {
	manifest: ExtensionManifest;
	workerSource: string;
	scriptName?: string;
}

export interface DeployMiniAppResult {
	scriptName: string;
	deployed: boolean;
	message: string;
}

export interface DeleteMiniAppResult {
	scriptName: string;
	deleted: boolean;
	message: string;
}

export interface SmokeTestMiniAppResult {
	ok: boolean;
	route: string;
	status?: number;
	contentType?: string | null;
	message: string;
}

export interface SecureMiniAppResponseInput {
	response: Response;
	slug: string;
	requestUrl: string;
	hostContextToken?: string;
}

const forwardedMiniAppHeaders = new Set([
	"accept",
	"accept-language",
	"cache-control",
	"content-type",
	"user-agent",
]);
const maxMiniAppResponseBytes = 256 * 1024;

export async function deployMiniAppWorker(env: Env, input: DeployMiniAppInput): Promise<DeployMiniAppResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	const namespace = env.CLOUDFLARE_DISPATCH_NAMESPACE;
	const scriptName = input.scriptName ?? scriptNameForManifest(input.manifest);

	if (!accountId || !apiToken || !namespace) {
		return {
			scriptName,
			deployed: false,
			message: "Cloudflare account ID, API token, or dispatch namespace is not configured.",
		};
	}

	const mainModule = `${scriptName}.mjs`;
	const form = new FormData();
	form.append("metadata", new Blob([JSON.stringify({
		main_module: mainModule,
		compatibility_date: "2026-06-17",
		bindings: bindingsToUploadMetadata(input.manifest.bindings),
		tags: ["enchiridion", input.manifest.slug],
	})], { type: "application/json" }));
	form.append(mainModule, new File([input.workerSource], mainModule, { type: "application/javascript+module" }));

	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
		{
			method: "PUT",
			headers: { authorization: `Bearer ${apiToken}` },
			body: form,
		},
	);

	if (!response.ok) {
		return {
			scriptName,
			deployed: false,
			message: `Cloudflare upload failed with ${response.status}: ${await response.text()}`,
		};
	}

	return {
		scriptName,
		deployed: true,
		message: "Mini app Worker deployed.",
	};
}

export async function deleteMiniAppWorker(env: Env, scriptName: string): Promise<DeleteMiniAppResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	const namespace = env.CLOUDFLARE_DISPATCH_NAMESPACE;

	if (!accountId || !apiToken || !namespace) {
		return {
			scriptName,
			deleted: false,
			message: "Cloudflare account ID, API token, or dispatch namespace is not configured.",
		};
	}

	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
		{
			method: "DELETE",
			headers: { authorization: `Bearer ${apiToken}` },
		},
	);

	if (!response.ok && response.status !== 404) {
		return {
			scriptName,
			deleted: false,
			message: `Cloudflare cleanup failed with ${response.status}: ${await response.text()}`,
		};
	}

	return {
		scriptName,
		deleted: true,
		message: response.status === 404 ? "Mini app Worker candidate was already absent." : "Mini app Worker candidate removed.",
	};
}

export function scriptNameForManifest(manifest: Pick<ExtensionManifest, "slug">): string {
	return `enchiridion-${manifest.slug}`;
}

export function candidateScriptNameForManifest(manifest: Pick<ExtensionManifest, "slug">): string {
	const suffix = crypto.randomUUID().slice(0, 8);
	const base = scriptNameForManifest(manifest);
	return `${base.slice(0, 54)}-${suffix}`;
}

export function createMiniAppDispatchRequest(source: Request, hostContextToken?: string): Request {
	const headers = new Headers();

	for (const [key, value] of source.headers) {
		const normalized = key.toLowerCase();
		if (forwardedMiniAppHeaders.has(normalized)) {
			headers.set(normalized, value);
		}
	}
	if (hostContextToken) {
		headers.set("x-enchiridion-host-context", hostContextToken);
	}

	return new Request(source, { headers });
}

export function isTransientMiniAppLoadFailure(message: string): boolean {
	return /\bLoad failed\b/i.test(message)
		|| /\bscript\b.*\bnot found\b/i.test(message)
		|| /\bnot found\b.*\bdispatch\b/i.test(message);
}

export async function secureMiniAppResponse(input: SecureMiniAppResponseInput): Promise<Response> {
	const redirectBlock = validateMiniAppRedirect(input);
	if (redirectBlock) {
		return redirectBlock;
	}

	const sourceHeaders = input.response.headers;
	const contentType = sourceHeaders.get("content-type");
	const headerBlock = validateMiniAppResponseHeaders(sourceHeaders);
	if (headerBlock) {
		return blockedMiniAppResponse({
			error: "Unsafe mini app response blocked",
			slug: input.slug,
			reason: headerBlock,
		});
	}

	const headers = createSecureMiniAppResponseHeaders(sourceHeaders, input.response.status);

	const bodyResult = await readMiniAppResponseBody(input.response);
	if (!bodyResult.ok) {
		return blockedMiniAppResponse({
			error: "Unsafe mini app response blocked",
			slug: input.slug,
			reason: bodyResult.reason,
		});
	}

	const bodyBlock = validateMiniAppResponseBody(bodyResult.text, contentType, input.hostContextToken);
	if (bodyBlock) {
		return blockedMiniAppResponse({
			error: "Unsafe mini app response blocked",
			slug: input.slug,
			reason: bodyBlock,
		});
	}

	if (contentType?.toLowerCase().includes("text/html")) {
		return new Response(bodyResult.text, {
			status: input.response.status,
			statusText: input.response.statusText,
			headers,
		});
	}

	return new Response(bodyResult.body, {
		status: input.response.status,
		statusText: input.response.statusText,
		headers,
	});
}

export async function smokeTestMiniAppWorker(
	env: Env,
	input: { manifest: ExtensionManifest; scriptName: string },
): Promise<SmokeTestMiniAppResult> {
	const route = primaryRouteForManifest(input.manifest);
	if (!env.MINI_APP_DISPATCHER) {
		return {
			ok: false,
			route,
			message: "Dispatch namespace binding is not configured.",
		};
	}

	let token: string | undefined;
	if (input.manifest.hostApis.length > 0) {
		let secret: string;
		try {
			secret = requireHostSigningSecret(env);
		} catch (error) {
			if (error instanceof Response) {
				return {
					ok: false,
					route,
					status: error.status,
					message: "HOST_SIGNING_SECRET is not configured.",
				};
			}
			throw error;
		}
		token = await signHostContext({
			app: input.manifest.slug,
			scopes: input.manifest.hostApis,
			expiresAt: Date.now() + 5 * 60 * 1000,
			context: { path: route, smokeTest: true },
		}, secret);
	}

	const url = new URL(route, "https://enchiridion.local");
	const headers = new Headers({
		accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
	});
	if (token) {
		headers.set("x-enchiridion-host-context", token);
	}
	const request = new Request(url, {
		headers,
	});

	try {
		const response = await env.MINI_APP_DISPATCHER.get(input.scriptName).fetch(request);
		const contentType = response.headers.get("content-type");
		const headerFailure = validateMiniAppResponseHeaders(response.headers);
		if (headerFailure) {
			return {
				ok: false,
				route,
				status: response.status,
				contentType,
				message: `Smoke test failed with ${response.status}: ${headerFailure}`,
			};
		}

		const bodyResult = await readMiniAppResponseBody(response);
		if (!bodyResult.ok) {
			return {
				ok: false,
				route,
				status: response.status,
				contentType,
				message: `Smoke test failed with ${response.status}: ${bodyResult.reason}`,
			};
		}

		const body = bodyResult.text;
		const bodySample = sampleBody(body);
		if (!response.ok) {
			return {
				ok: false,
				route,
				status: response.status,
				contentType,
				message: `Smoke test failed with ${response.status}: ${bodySample}`,
			};
		}

		const contractFailure = validateSmokeTestBody(contentType, body, token);
		if (contractFailure) {
			return {
				ok: false,
				route,
				status: response.status,
				contentType,
				message: `Smoke test failed with ${response.status}: ${contractFailure}`,
			};
		}

		return {
			ok: true,
			route,
			status: response.status,
			contentType,
			message: "Primary mini-app route rendered successfully.",
		};
	} catch (error) {
		return {
			ok: false,
			route,
			message: error instanceof Error ? error.message : "Smoke test failed.",
		};
	}
}

function validateSmokeTestBody(contentType: string | null, body: string, hostContextToken?: string): string | null {
	const unsafeResponse = validateMiniAppResponseBody(body, contentType, hostContextToken);
	if (unsafeResponse) {
		return unsafeResponse;
	}

	if (!contentType?.toLowerCase().includes("text/html")) {
		return `primary route must return text/html, got ${contentType ?? "no content-type"}`;
	}

	const trimmed = body.trim();
	if (/Load failed/i.test(trimmed)) {
		return `primary route returned a generic failure body: ${sampleBody(trimmed)}`;
	}

	if (trimmed.length < 20 || !/<(?:!doctype|html|body|main|section|article|h1|h2|div)\b/i.test(trimmed)) {
		return `primary route returned an empty or non-HTML body: ${sampleBody(trimmed)}`;
	}

	return null;
}

function sampleBody(body: string): string {
	const sample = body.replace(/\s+/g, " ").trim().slice(0, 500);
	return sample || "<empty body>";
}

function validateMiniAppResponseHeaders(headers: Headers): string | null {
	if (headers.get("content-encoding")) {
		return "dynamic mini app responses cannot set content-encoding";
	}

	return null;
}

function createSecureMiniAppResponseHeaders(sourceHeaders: Headers, status: number): Headers {
	const headers = new Headers();
	const contentType = sourceHeaders.get("content-type");
	if (contentType) {
		headers.set("content-type", contentType);
	}
	if (status >= 300 && status < 400) {
		const location = sourceHeaders.get("location");
		if (location) {
			headers.set("location", location);
		}
	}

	headers.set("cache-control", "no-store");
	headers.set("content-security-policy", miniAppContentSecurityPolicy);
	headers.set("cross-origin-resource-policy", "same-origin");
	headers.set("permissions-policy", miniAppPermissionsPolicy);
	headers.set("referrer-policy", "no-referrer");
	headers.set("x-content-type-options", "nosniff");

	return headers;
}

async function readMiniAppResponseBody(response: Response): Promise<
	| { ok: true; body: ArrayBuffer; text: string }
	| { ok: false; reason: string }
> {
	const contentLength = parseContentLength(response.headers.get("content-length"));
	if (contentLength !== null && contentLength > maxMiniAppResponseBytes) {
		return { ok: false, reason: miniAppResponseSizeMessage() };
	}

	if (!response.body) {
		return { ok: true, body: new ArrayBuffer(0), text: "" };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (!value) {
			continue;
		}

		total += value.byteLength;
		if (total > maxMiniAppResponseBytes) {
			await reader.cancel();
			return { ok: false, reason: miniAppResponseSizeMessage() };
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return {
		ok: true,
		body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		text: new TextDecoder().decode(bytes),
	};
}

function parseContentLength(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return null;
	}

	return Math.trunc(parsed);
}

function miniAppResponseSizeMessage(): string {
	return `dynamic mini app responses must be ${maxMiniAppResponseBytes} bytes or smaller`;
}

function validateMiniAppRedirect(input: SecureMiniAppResponseInput): Response | null {
	if (input.response.status < 300 || input.response.status >= 400) {
		return null;
	}

	const location = input.response.headers.get("location");
	if (!location) {
		return null;
	}

	let target: URL;
	try {
		target = new URL(location, input.requestUrl);
	} catch {
		return blockedMiniAppResponse({
			error: "Unsafe mini app redirect blocked",
			slug: input.slug,
		});
	}

	if (input.hostContextToken && location.includes(input.hostContextToken)) {
		return blockedMiniAppResponse({
			error: "Unsafe mini app redirect blocked",
			slug: input.slug,
			reason: "dynamic mini app redirects cannot expose host context tokens",
		});
	}

	const requestUrl = new URL(input.requestUrl);
	if (target.origin === requestUrl.origin && isMiniAppRouteForSlug(target.pathname, input.slug)) {
		return null;
	}

	return blockedMiniAppResponse({
		error: "Unsafe mini app redirect blocked",
		slug: input.slug,
	});
}

function blockedMiniAppResponse(input: { error: string; slug: string; reason?: string }): Response {
	return new Response(JSON.stringify(input), {
		status: 502,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"content-security-policy": miniAppContentSecurityPolicy,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
		},
	});
}

function validateMiniAppResponseBody(body: string, contentType: string | null, hostContextToken?: string): string | null {
	if (hostContextToken && body.includes(hostContextToken)) {
		return "dynamic mini app responses cannot expose host context tokens";
	}

	if (contentType?.toLowerCase().includes("text/html")) {
		return validateMiniAppHtmlSafety(body);
	}

	return null;
}

function validateMiniAppHtmlSafety(body: string): string | null {
	if (/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i.test(body)) {
		return "dynamic mini app pages cannot trigger meta refresh navigation";
	}
	if (/<script\b/i.test(body)) {
		return "dynamic mini app pages cannot include browser scripts";
	}
	if (/<[^>]+\son[a-z]+\s*=/i.test(body)) {
		return "dynamic mini app pages cannot include inline browser event handlers";
	}
	if (/javascript\s*:/i.test(body)) {
		return "dynamic mini app pages cannot include javascript: URLs";
	}
	if (/<form\b/i.test(body)) {
		return "dynamic mini app pages cannot include forms";
	}

	return null;
}

function isMiniAppRouteForSlug(pathname: string, slug: string): boolean {
	const basePath = `/apps/${slug}`;
	return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

const miniAppContentSecurityPolicy = [
	"sandbox",
	"default-src 'none'",
	"base-uri 'none'",
	"connect-src 'none'",
	"font-src 'self' data:",
	"form-action 'none'",
	"frame-ancestors 'self'",
	"img-src 'self' data: blob:",
	"manifest-src 'none'",
	"media-src 'self' data:",
	"object-src 'none'",
	"script-src 'none'",
	"style-src 'unsafe-inline'",
	"worker-src 'none'",
].join("; ");

const miniAppPermissionsPolicy = [
	"accelerometer=()",
	"ambient-light-sensor=()",
	"autoplay=()",
	"camera=()",
	"display-capture=()",
	"encrypted-media=()",
	"fullscreen=()",
	"geolocation=()",
	"gyroscope=()",
	"magnetometer=()",
	"microphone=()",
	"midi=()",
	"payment=()",
	"picture-in-picture=()",
	"publickey-credentials-get=()",
	"screen-wake-lock=()",
	"usb=()",
	"xr-spatial-tracking=()",
].join(", ");

function bindingsToUploadMetadata(bindings: ExtensionBinding[]): UploadBindingMetadata[] {
	return bindings.map((binding) => {
		if (binding.type === "kv_namespace") {
			return { type: "kv_namespace", name: binding.name, namespace_id: `${binding.name}_ID_REQUIRED` };
		}
		if (binding.type === "d1_database") {
			return { type: "d1", name: binding.name, database_id: `${binding.name}_ID_REQUIRED` };
		}
		return { type: "r2_bucket", name: binding.name, bucket_name: `${binding.name.toLowerCase().replace(/_/g, "-")}-required` };
	});
}

function primaryRouteForManifest(manifest: ExtensionManifest): string {
	return manifest.routes.find((route) => route.mode === "worker-page")?.path
		?? manifest.routes[0]?.path
		?? `/apps/${manifest.slug}`;
}
