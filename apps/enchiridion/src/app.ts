import { flue } from "@flue/runtime/routing";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { authenticate, requirePrincipal, unauthorizedResponse } from "./lib/auth";
import { createMiniAppDispatchRequest, secureMiniAppResponse } from "./lib/cloudflare-dispatch";
import { registerRuntimeProviders } from "./lib/flue-providers";
import { requireHostApiContext, requireHostSigningSecret, signHostContext } from "./lib/host-context";
import {
	createBookmark,
	createKanbanCard,
	createProject,
	ensureBuiltins,
	getAppSnapshot,
	getExtension,
	getOrCreateDailyNote,
	listBoards,
	listBookmarks,
	listExtensions,
	listMiniAppAudit,
	listProjects,
	listRecentDailyNotes,
	listScheduledWorkflows,
	saveDailyNote,
	searchResources,
} from "./lib/repository";
import {
	renderBookmarkFragment,
	renderBookmarksPage,
	renderProjectsFragment,
	renderProjectsPage,
} from "./lib/mini-app-pages";
import type { Env, JsonObject } from "./lib/types";

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
		return;
	}

	registerRuntimeProviders(c.env);

	if (c.req.path.startsWith("/api/host/")) {
		await next();
		return;
	}

	const principal = authenticate(c.req.raw, c.env);
	if (!principal) {
		return unauthorizedResponse();
	}

	await ensureBuiltins(c.env);
	await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", async (c) => {
	return fetchAsset(c.env, c.req.raw, "/index.html");
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

app.get("/api/mini-app-audit", async (c) => {
	const limit = Number(c.req.query("limit") ?? "12");
	const boundedLimit = Number.isFinite(limit) ? limit : 12;
	return c.json(await listMiniAppAudit(c.env, boundedLimit, c.req.query("slug")));
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

	if (!extension?.deployedScriptName || !c.env.MINI_APP_DISPATCHER) {
		return json({ error: "Mini app route not found", slug }, 404);
	}

	const secret = requireHostSigningSecret(c.env, c.req.raw);
	const token = await signHostContext({
		app: slug,
		scopes: extension.hostApis,
		expiresAt: Date.now() + 5 * 60 * 1000,
		context: { path: c.req.path },
	}, secret);

	const request = createMiniAppDispatchRequest(c.req.raw, token);

	let response: Response;
	try {
		response = await c.env.MINI_APP_DISPATCHER.get(extension.deployedScriptName).fetch(request);
	} catch (error) {
		return miniAppLoadFailedResponse(c.req.raw, slug, error);
	}

	return secureMiniAppResponse({
		response,
		slug,
		requestUrl: c.req.raw.url,
		hostContextToken: token,
	});
}

app.get("*", async (c) => {
	return fetchAsset(c.env, c.req.raw);
});

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function miniAppLoadFailedResponse(request: Request, slug: string, error: unknown): Response {
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
