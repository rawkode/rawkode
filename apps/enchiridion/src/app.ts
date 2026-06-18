import { flue } from "@flue/runtime/routing";
import { observe, type FlueEvent } from "@flue/runtime";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { authenticate, requirePrincipal, unauthorizedResponse } from "./lib/auth";
import {
	checkPasswordAuthThrottle,
	clearPasswordAuthFailures,
	passwordAuthThrottleResponse,
	recordPasswordAuthFailure,
} from "./lib/auth-throttle";
import { createMiniAppDispatchRequest, isTransientMiniAppLoadFailure, secureMiniAppResponse } from "./lib/cloudflare-dispatch";
import { registerRuntimeProviders } from "./lib/flue-providers";
import {
	isHostContextPathForApp,
	isTrustedSchedulerWorkflowRequest,
	requireHostApiContext,
	requireHostSigningSecret,
	signHostContext,
} from "./lib/host-context";
import {
	createBookmark,
	createAuditRecord,
	createKanbanCard,
	createProject,
	completeMiniAppBuild,
	ensureBuiltins,
	expireMiniAppBuild,
	failMiniAppBuild,
	getAppSnapshot,
	getExtension,
	getMiniAppBuild,
	getOrCreateDailyNote,
	listMiniAppBuildEvents,
	listBoards,
	listBookmarks,
	listExtensionBindingRequests,
	listExtensions,
	listMiniAppAudit,
	listProjects,
	listRecentDailyNotes,
	listScheduledWorkflows,
	setScheduledWorkflowEnabled,
	saveDailyNote,
	searchResources,
} from "./lib/repository";
import { admitMiniAppBuild, miniAppBuildCreateSchema } from "./lib/mini-app-builds";
import {
	renderBookmarkFragment,
	renderBookmarksPage,
	renderProjectsFragment,
	renderProjectsPage,
} from "./lib/mini-app-pages";
import { refineAgentPrompt } from "./lib/prompt-refinement";
import type { Env, ExtensionBindingRequestStatus, JsonObject, RegisteredExtension } from "./lib/types";

type HonoEnv = {
	Bindings: Env;
};

const app = new Hono<HonoEnv>();

const saveNoteSchema = z.object({
	documentJson: z.record(z.string(), z.unknown()),
	version: z.number().int().optional(),
});

const bookmarkSchema = z.object({
	title: z.string().min(1),
	url: z.url(),
	description: z.string().optional(),
	tags: z.array(z.string()).optional(),
});

const projectSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
});

const cardSchema = z.object({
	boardId: z.string().optional(),
	columnId: z.string().optional(),
	title: z.string().min(1),
	description: z.string().optional(),
});

const scheduledWorkflowUpdateSchema = z.object({
	enabled: z.boolean(),
});

const promptRefinementSchema = z.object({
	mode: z.enum(["ask", "build", "update"]),
	prompt: z.string().trim().min(1).max(8_000),
	contextPrompt: z.string().max(4_000).optional(),
	contextResponse: z.string().max(8_000).optional(),
	targetSlug: z.string().max(160).optional(),
});

const miniAppDispatchRetryDelaysMs = [150, 500, 1_000];
let miniAppBuildObserverInstalled = false;

installMiniAppBuildObserver();

app.onError((error) => {
	if (error instanceof Response) {
		return error;
	}

	console.error(error);
	return json({ error: error.message || "Internal error" }, 500);
});

app.use("*", async (c, next) => {
	if (c.req.path === "/health") {
		await next();
		return c.res;
	}

	registerRuntimeProviders(c.env);

	if (c.req.path.startsWith("/api/host/")) {
		await next();
		return c.res;
	}

	const unsafeRequestBlock = unsafeCrossOriginResponse(c.req.raw);
	if (unsafeRequestBlock) {
		return unsafeRequestBlock;
	}

	const passwordThrottle = await checkPasswordAuthThrottle(c.env, c.req.raw);
	if (passwordThrottle.limited) {
		return passwordAuthThrottleResponse(passwordThrottle.retryAfterSeconds);
	}

	if (c.req.path.startsWith("/api/flue/workflows/") && await isTrustedSchedulerWorkflowRequest(c.env, c.req.raw)) {
		await next();
		return c.res;
	}

	const principal = authenticate(c.req.raw, c.env);
	if (!principal) {
		if (passwordThrottle.keyHash) {
			const failure = await recordPasswordAuthFailure(c.env, passwordThrottle.keyHash);
			if (failure.limited) {
				return passwordAuthThrottleResponse(failure.retryAfterSeconds);
			}
		}
		return unauthorizedResponse();
	}

	if (principal.source === "password" && passwordThrottle.keyHash) {
		await clearPasswordAuthFailures(c.env, passwordThrottle.keyHash);
	}

	await ensureBuiltins(c.env);
	await next();
	return c.res;
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
	return fetchAsset(c.env, c.req.raw);
});

app.get("/index.html", async (c) => {
	return fetchAsset(c.env, c.req.raw);
});

app.get("/_astro/*", async (c) => {
	return fetchAsset(c.env, c.req.raw);
});

app.get("/api/bootstrap", async (c) => {
	const principal = requirePrincipal(c.req.raw, c.env);
	const date = c.req.query("date");
	return c.json(await getAppSnapshot(c.env, principal, date));
});

app.get("/api/daily-notes/today", async (c) => {
	return c.json(await getOrCreateDailyNote(c.env));
});

app.get("/api/daily-notes", async (c) => {
	const limit = Number(c.req.query("limit") ?? "14");
	return c.json(await listRecentDailyNotes(c.env, Number.isFinite(limit) ? limit : 14, c.req.query("before")));
});

app.get("/api/daily-notes/:date", async (c) => {
	return c.json(await getOrCreateDailyNote(c.env, c.req.param("date")));
});

app.put("/api/daily-notes/:date", async (c) => {
	const payload = saveNoteSchema.parse(await c.req.json());
	return c.json(await saveDailyNote(c.env, c.req.param("date"), payload.documentJson as JsonObject, payload.version));
});

app.get("/api/search", async (c) => {
	return c.json(await searchResources(c.env, c.req.query("q") ?? "", 30));
});

app.get("/api/extensions", async (c) => {
	return c.json(await listExtensions(c.env));
});

app.get("/api/commands", async (c) => {
	const extensions = await listExtensions(c.env);
	return c.json(extensions.flatMap((extension) => extension.commands));
});

app.get("/api/editor-blocks", async (c) => {
	const extensions = await listExtensions(c.env);
	return c.json(extensions.flatMap((extension) => extension.editorBlocks));
});

app.get("/api/scheduled-workflows", async (c) => {
	return c.json(await listScheduledWorkflows(c.env));
});

app.patch("/api/scheduled-workflows/:id", async (c) => {
	const payload = scheduledWorkflowUpdateSchema.parse(await c.req.json());
	const workflow = await setScheduledWorkflowEnabled(c.env, c.req.param("id"), payload.enabled);
	if (!workflow) {
		return c.json({ error: "Scheduled workflow not found" }, 404);
	}

	await createAuditRecord(c.env, {
		slug: workflow.extensionSlug ?? "system",
		action: "scheduled-workflow",
		status: payload.enabled ? "enabled" : "disabled",
		details: {
			enabled: payload.enabled,
			scheduledWorkflowId: workflow.id,
			workflowName: workflow.workflowName,
		},
	});

	return c.json(workflow);
});

app.get("/api/mini-app-audit", async (c) => {
	const limit = Number(c.req.query("limit") ?? "12");
	const boundedLimit = Number.isFinite(limit) ? limit : 12;
	return c.json(await listMiniAppAudit(c.env, boundedLimit, c.req.query("slug")));
});

app.get("/api/extension-binding-requests", async (c) => {
	const limit = Number(c.req.query("limit") ?? "20");
	const boundedLimit = Number.isFinite(limit) ? limit : 20;
	const status = c.req.query("status");
	if (status && status !== "pending" && status !== "provisioned" && status !== "rejected") {
		return c.json({ error: "Invalid binding request status" }, 400);
	}
	const requestStatus = status as ExtensionBindingRequestStatus | undefined;
	return c.json(await listExtensionBindingRequests(c.env, {
		limit: boundedLimit,
		...(requestStatus ? { status: requestStatus } : {}),
	}));
});

app.post("/api/mini-app-builds", async (c) => {
	const payload = miniAppBuildCreateSchema.parse(await c.req.json());
	const build = await admitMiniAppBuild(c.env, payload);
	return c.json(build, 202);
});

app.get("/api/mini-app-builds/:id", async (c) => {
	const build = await resolveMiniAppBuildForResponse(c.env, c.req.param("id"));
	if (!build) {
		return c.json({ error: "Mini app build not found" }, 404);
	}
	const events = await listMiniAppBuildEvents(c.env, build.id, { limit: 100 });
	return c.json({ ...build, events });
});

app.post("/api/agent/refine-prompt", async (c) => {
	if (!c.env.AI) {
		return c.json({ error: "AI prompt refinement is not available in this environment." }, 503);
	}

	const payload = promptRefinementSchema.parse(await c.req.json());
	const prompt = await refineAgentPrompt(c.env.AI, payload);
	return c.json({ prompt });
});

app.get("/api/apps/bookmarks/bookmarks", async (c) => {
	return c.json(await listBookmarks(c.env, c.req.query("tag")));
});

app.post("/api/apps/bookmarks/bookmarks", async (c) => {
	const payload = bookmarkSchema.parse(await c.req.json());
	return c.json(await createBookmark(c.env, payload), 201);
});

app.get("/api/apps/projects/projects", async (c) => {
	return c.json(await listProjects(c.env));
});

app.post("/api/apps/projects/projects", async (c) => {
	const payload = projectSchema.parse(await c.req.json());
	return c.json(await createProject(c.env, payload), 201);
});

app.get("/api/apps/projects/boards", async (c) => {
	return c.json(await listBoards(c.env));
});

app.post("/api/apps/projects/cards", async (c) => {
	const payload = cardSchema.parse(await c.req.json());
	return c.json(await createKanbanCard(c.env, payload), 201);
});

app.post("/api/host-context", async (c) => {
	const secret = requireHostSigningSecret(c.env, c.req.raw);
	const payload = z.object({
		app: z.string().min(1),
		scopes: z.array(z.string()),
		context: z.record(z.string(), z.unknown()).default({}),
	}).parse(await c.req.json());
	const extension = await getExtension(c.env, payload.app);
	if (!extension) {
		return c.json({ error: "Host context app not found", app: payload.app }, 404);
	}
	if (extension.status === "disabled") {
		return c.json({ error: "Host context app is disabled", app: payload.app }, 403);
	}

	const scopes = Array.from(new Set(payload.scopes));
	const undeclaredScopes = scopes.filter((scope) => !extension.hostApis.includes(scope));
	if (undeclaredScopes.length > 0) {
		return c.json({
			error: "Requested host-context scopes are not declared by app",
			app: payload.app,
			scopes: undeclaredScopes,
		}, 403);
	}

	if (!isHostContextPathForApp(payload.context, payload.app)) {
		return c.json({
			error: "Host context path must stay under app route",
			app: payload.app,
		}, 403);
	}
	if (!isHostContextRouteDeclared(extension, payload.context)) {
		return c.json({
			error: "Host context path must match a declared app route",
			app: payload.app,
		}, 403);
	}

	const token = await signHostContext({
		...payload,
		scopes,
		expiresAt: Date.now() + 5 * 60 * 1000,
	}, secret);

	return c.json({ token });
});

app.get("/api/host/resource-index/search", async (c) => {
	const requiredScope = "resource-index:read";
	let hostContext;
	try {
		hostContext = await requireHostApiContext(c.env, c.req.raw, requiredScope);
	} catch (error) {
		if (error instanceof Response) {
			return error;
		}
		throw error;
	}

	const extension = await getExtension(c.env, hostContext.app);
	if (!extension) {
		return c.json({ error: "Host context app not found", app: hostContext.app }, 403);
	}
	if (extension.status === "disabled") {
		return c.json({ error: "Host context app is disabled", app: hostContext.app }, 403);
	}
	if (!isHostContextRouteDeclared(extension, hostContext.context)) {
		return c.json({
			error: "Host context token path is not a declared app route",
			app: hostContext.app,
		}, 403);
	}
	if (!extension.hostApis.includes(requiredScope)) {
		return c.json({
			error: "Host context app no longer declares required scope",
			app: hostContext.app,
			scope: requiredScope,
		}, 403);
	}

	const limit = Number(c.req.query("limit") ?? "20");
	const boundedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
	return c.json(await searchResources(c.env, c.req.query("q") ?? "", boundedLimit));
});

app.route("/api/flue", flue());

app.get("/apps/bookmarks", async (c) => {
	return renderBookmarksPage(await listBookmarks(c.env));
});

app.get("/apps/bookmarks/fragment", async (c) => {
	return renderBookmarkFragment(await listBookmarks(c.env, c.req.query("tag")), c.req.query("tag"));
});

app.get("/apps/projects", async (c) => {
	return renderProjectsPage(await listProjects(c.env), await listBoards(c.env));
});

app.get("/apps/projects/fragment", async (c) => {
	return renderProjectsFragment(await listBoards(c.env), c.req.query("boardId"));
});

app.all("/apps/:slug", dispatchMiniAppRoute);
app.all("/apps/:slug/*", dispatchMiniAppRoute);

async function dispatchMiniAppRoute(c: Context<HonoEnv>): Promise<Response> {
	const slug = c.req.param("slug");
	if (!slug) {
		return json({ error: "Mini app route not found" }, 404);
	}

	const extension = await getExtension(c.env, slug);

	if (extension?.status === "disabled") {
		return json({ error: "Mini app is disabled", slug }, 403);
	}

	if (extension && !isDispatchableMiniAppRoute(extension, c.req.path)) {
		return json({ error: "Mini app route not declared", slug, path: c.req.path }, 404);
	}

	if (!extension?.deployedScriptName || !c.env.MINI_APP_DISPATCHER) {
		return json({ error: "Mini app route not found", slug }, 404);
	}

	const token = extension.hostApis.length > 0
		? await signHostContext({
			app: slug,
			scopes: extension.hostApis,
			expiresAt: Date.now() + 5 * 60 * 1000,
			context: { path: c.req.path },
		}, requireHostSigningSecret(c.env, c.req.raw))
		: undefined;

	const request = createMiniAppDispatchRequest(c.req.raw, token);

	let response: Response;
	try {
		response = await fetchMiniAppWorkerWithRetries(c.env.MINI_APP_DISPATCHER.get(extension.deployedScriptName), request);
	} catch (error) {
		return miniAppLoadFailedResponse(c.req.raw, extension, error);
	}

	return secureMiniAppResponse({
		response,
		slug,
		requestUrl: c.req.raw.url,
		hostContextToken: token,
	});
}

function isHostContextRouteDeclared(extension: RegisteredExtension, context: JsonObject): boolean {
	const path = context.path;
	return typeof path === "string" && isDispatchableMiniAppRoute(extension, path);
}

function isDispatchableMiniAppRoute(extension: RegisteredExtension, path: string): boolean {
	const requestPath = normalizeRoutePath(path);
	return extension.routes.some((route) =>
		(route.mode === "worker-page" || route.mode === "worker-fragment")
		&& normalizeRoutePath(route.path) === requestPath
	);
}

function normalizeRoutePath(path: string): string {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

async function fetchMiniAppWorkerWithRetries(fetcher: Fetcher, request: Request): Promise<Response> {
	const maxAttempts = canRetryMiniAppDispatch(request) ? miniAppDispatchRetryDelaysMs.length + 1 : 1;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const dispatchRequest = attempt === 1 ? request : request.clone();
			return await fetcher.fetch(dispatchRequest as unknown as RequestInfo);
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error || "Mini app dispatch failed.");
			if (attempt >= maxAttempts || !isTransientMiniAppLoadFailure(message)) {
				throw error;
			}

			await waitForMiniAppDispatchRetry(attempt);
		}
	}

	throw lastError instanceof Error ? lastError : new Error("Mini app dispatch failed.");
}

function canRetryMiniAppDispatch(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
}

function waitForMiniAppDispatchRetry(attempt: number): Promise<void> {
	const delayMs = miniAppDispatchRetryDelaysMs[Math.min(attempt - 1, miniAppDispatchRetryDelaysMs.length - 1)] ?? 0;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

app.get("*", async (c) => {
	return fetchAsset(c.env, c.req.raw);
});

function installMiniAppBuildObserver() {
	if (miniAppBuildObserverInstalled) {
		return;
	}
	miniAppBuildObserverInstalled = true;
	observe((event, ctx) => {
		if (event.type !== "run_end") {
			return;
		}
		const payload = asJsonObject(ctx.payload);
		const buildId = typeof payload.buildId === "string" ? payload.buildId : "";
		if (!buildId) {
			return;
		}

		void syncMiniAppBuildFromRunEnd(ctx.env as Env, event, buildId);
	});
}

async function syncMiniAppBuildFromRunEnd(env: Env, event: Extract<FlueEvent, { type: "run_end" }>, buildId: string): Promise<void> {
	const build = await getMiniAppBuild(env, buildId);
	if (!build || build.status === "completed" || build.status === "failed" || build.status === "expired") {
		return;
	}

	if (event.isError) {
		const message = errorMessage(event.error);
		await failMiniAppBuild(env, {
			id: buildId,
			status: isWorkflowInterruption(message) ? "interrupted" : "failed",
			error: {
				message,
				runId: event.runId,
				source: "flue-run-end",
			},
		});
		return;
	}

	const result = asJsonObject(event.result);
	await completeMiniAppBuild(env, {
		id: buildId,
		result: {
			...result,
			runId: event.runId,
		},
		status: miniAppBuildSucceeded(result) ? "completed" : "failed",
		error: miniAppBuildSucceeded(result) ? undefined : {
			message: readResultMessage(result) ?? "Mini app build finished without an activatable app.",
			runId: event.runId,
		},
	});
}

async function resolveMiniAppBuildForResponse(env: Env, id: string) {
	const build = await getMiniAppBuild(env, id);
	if (!build) {
		return null;
	}
	if (
		(build.status === "pending" || build.status === "running" || build.status === "interrupted")
		&& new Date(build.deadlineAt).getTime() <= Date.now()
	) {
		return expireMiniAppBuild(env, build.id);
	}
	return build;
}

function miniAppBuildSucceeded(result: JsonObject): boolean {
	const status = typeof result.status === "string" ? result.status : "";
	return status === "deployed"
		|| status === "updated"
		|| status === "registered"
		|| status === "requires_binding_provisioning"
		|| status === "update_deferred";
}

function readResultMessage(result: JsonObject): string | undefined {
	const message = result.message;
	return typeof message === "string" && message.trim() ? message : undefined;
}

function asJsonObject(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return "An internal error occurred.";
}

function isWorkflowInterruption(message: string): boolean {
	return /workflow execution was interrupted|interrupted/i.test(message);
}

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function unsafeCrossOriginResponse(request: Request): Response | null {
	if (!isUnsafeMethod(request.method)) {
		return null;
	}

	const site = request.headers.get("sec-fetch-site")?.toLowerCase();
	if (site === "cross-site" || site === "same-site") {
		return json({ error: "Cross-origin write requests are not allowed" }, 403);
	}

	const origin = request.headers.get("origin");
	if (!origin) {
		return null;
	}

	const requestUrl = new URL(request.url);
	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return json({ error: "Cross-origin write requests are not allowed" }, 403);
	}

	if (originUrl.origin !== requestUrl.origin) {
		return json({ error: "Cross-origin write requests are not allowed" }, 403);
	}

	return null;
}

function isUnsafeMethod(method: string): boolean {
	return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function miniAppLoadFailedResponse(request: Request, extension: RegisteredExtension, error: unknown): Response {
	const slug = extension.slug;
	const message = error instanceof Error ? error.message : "The mini app Worker did not return a response.";
	if (!request.headers.get("accept")?.toLowerCase().includes("text/html")) {
		return json({ error: "Mini app failed to load", slug, message }, 502);
	}

	return new Response(`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${escapeHtml(slug)} failed to load</title>
		<style>
			:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
			body { margin: 0; background: #f7f8f3; color: #20211d; }
			main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
			.kicker { color: #6b7f32; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
			.panel { border: 1px solid #d6d9cd; border-radius: 8px; background: #fff; padding: 22px; }
			code { background: #eef0e6; border-radius: 4px; padding: 2px 5px; }
		</style>
	</head>
	<body>
		<main>
			<div class="panel">
				<div class="kicker">Mini app unavailable</div>
				<h1>${escapeHtml(slug)} failed to load</h1>
				<p>The dynamic Worker is registered, but dispatch could not load it for this request.</p>
				<p><code>${escapeHtml(message)}</code></p>
			</div>
		</main>
	</body>
</html>`, {
		status: 502,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/html; charset=utf-8",
		},
	});
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function fetchAsset(env: Env, request: Request, pathOverride?: string): Promise<Response> {
	if (!pathOverride) {
		return env.ASSETS.fetch(request);
	}

	const url = new URL(request.url);
	url.pathname = pathOverride;
	return env.ASSETS.fetch(new Request(url, request));
}

export default app;
