import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

const requireAlchemy = createRequire(import.meta.resolve("alchemy"));
const runtimePackage = requireAlchemy.resolve(
	"@alchemy.run/cloudflare-runtime/package.json",
);
const runtimeManifest = JSON.parse(await readFile(runtimePackage, "utf8"));
const runtimeImport = (subpath) =>
	import(
		new URL(
			runtimeManifest.exports[`./${subpath}`].import,
			pathToFileURL(runtimePackage),
		).href
	);
const {
	Runtime,
	RuntimeLive,
	layerLocalBindings,
	layerLoopback,
	layerStorage,
	layerRegistry,
	layerProxy,
} = await runtimeImport("core");
const { Docker } = await runtimeImport("core/Docker");
const { Globals, Internet } = await runtimeImport("core/globals");
const { WorkerdLive } = await runtimeImport("core/workerd/Workerd");
const { PathsLive } = await import(
	new URL("dist/core/node/internal/Paths.mjs", pathToFileURL(runtimePackage))
		.href
);
// The convenience layer eagerly starts a detached Docker proxy. These Workers
// need only local services; reject container use and omit remote/cloud layers.
const localRuntime = (directory) =>
	RuntimeLive.pipe(
		Layer.provideMerge(layerLocalBindings()),
		Layer.provideMerge(layerProxy()),
		Layer.provide(Globals.GlobalsLive),
		Layer.provideMerge(layerLoopback()),
		Layer.provide(layerStorage({ directory })),
		Layer.provide(Internet.InternetLive),
		Layer.provideMerge(layerRegistry()),
		Layer.provide(PathsLive),
		Layer.provide(Layer.succeed(
			Docker,
			new Proxy({}, {
				get: () => {
					throw new Error("Containers are outside this smoke test");
				},
			}),
		)),
		Layer.provide(WorkerdLive),
	);
const { Text, Service, DurableObjectNamespace } = await runtimeImport(
	"core/bindings",
);
const temporary = await mkdtemp(join(tmpdir(), "e2-website-"));
for (const kind of ["CACHE", "CONFIG", "DATA", "STATE"]) {
	process.env[`XDG_${kind}_HOME`] = join(temporary, kind.toLowerCase());
}
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = {
	keys: [{
		...await exportJWK(publicKey),
		kid: "website-fixture",
		alg: "RS256",
	}],
};
const signOwner = async (subject) =>
	await new SignJWT({ email: "david@rawkode.academy" })
		.setProtectedHeader({ alg: "RS256", kid: "website-fixture" }).setSubject(
			subject,
		).setIssuer("https://test.cloudflareaccess.com").setAudience(
			"website-fixture",
		).setIssuedAt().setExpirationTime("1h").sign(privateKey);
const token = await signOwner("website-owner");
const otherToken = await signOwner("other-owner");
let workerUrl;
const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url, origin);
		if (
			url.pathname.startsWith("/_astro/") || url.pathname === "/favicon.svg"
		) {
			const file = resolve("website/dist/client", "." + url.pathname);
			if (!file.startsWith(resolve("website/dist/client") + "/")) {
				throw new Error("Invalid asset");
			}
			response.writeHead(200, {
				"Content-Type": file.endsWith(".svg")
					? "image/svg+xml"
					: file.endsWith(".css")
					? "text/css"
					: "text/javascript",
			}).end(await readFile(file));
			return;
		}
		if (url.pathname === "/favicon.ico") {
			response.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) {
			if (value && !["host", "connection", "content-length"].includes(name)) {
				headers.set(name, Array.isArray(value) ? value.join(",") : value);
			}
		}
		if (headers.get("x-test-unauthenticated") !== "true") {
			headers.set(
				"Cf-Access-Jwt-Assertion",
				headers.get("x-test-other-owner") === "true" ? otherToken : token,
			);
		}
		headers.set(
			"X-Test-Website-Url",
			url.pathname === "/mock-consent"
				? origin + "/oauth/callback/google?state=fixture"
				: url.href,
		);
		const upstream = await fetch(workerUrl, {
			method: request.method,
			headers,
			...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
			redirect: "manual",
		});
		const outgoing = Object.fromEntries(upstream.headers);
		if (outgoing.location === "http://localhost/mock-consent") {
			outgoing.location = origin + "/mock-consent";
		}
		response.writeHead(upstream.status, outgoing).end(
			Buffer.from(await upstream.arrayBuffer()),
		);
	} catch (error) {
		response.writeHead(500).end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const build = JSON.parse(await readFile("dist/website/build.json", "utf8"));
const moduleWrapper = `import site from './server/entry.mjs';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input) === 'https://test.cloudflareaccess.com/cdn-cgi/access/certs' ? Promise.resolve(Response.json(${
	JSON.stringify(jwks)
})) : nativeFetch(input, init);
export default {fetch:(request,env,ctx)=>site.fetch(new Request(request.headers.get('X-Test-Website-Url'),request),env,ctx)};`;
const config = (name, modules, bindings) => ({
	name,
	compatibilityDate: "2026-07-11",
	compatibilityFlags: ["nodejs_compat"],
	modules,
	bindings,
});
const authBindings = () =>
	Object.entries({
		WEBSITE_ORIGIN: origin,
		ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
		ACCESS_AUDIENCE: "website-fixture",
		ADMIN_EMAILS: "david@rawkode.academy",
	}).map(([name, value]) => Text.local(name, value));
const apiWrapper = `import api from './api.js';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input) === 'https://test.cloudflareaccess.com/cdn-cgi/access/certs' ? Promise.resolve(Response.json(${
	JSON.stringify(jwks)
})) : nativeFetch(input, init);
export default api;`;
const workerModules = async (directory) =>
	Promise.all(
		(await readdir(directory, { recursive: true, withFileTypes: true })).filter(
			(entry) => entry.isFile() && /\.(js|sql)$/.test(entry.name),
		).map(async (entry) => {
			const path = join(entry.parentPath, entry.name);
			return {
				name: path.slice(directory.length + 1),
				type: entry.name.endsWith(".sql") ? "Text" : "ESModule",
				content: await readFile(path, "utf8"),
			};
		}),
	);
const configs = [
	{
		...config("website-documents", await workerModules("dist/core-documents"), [
			DurableObjectNamespace.local({
				binding: "DOCUMENTS",
				className: "Documents",
			}),
		]),
		durableObjectNamespaces: [{ className: "Documents", sql: true }],
	},
	{
		...config("website-entities", await workerModules("dist/core-entities"), [
			DurableObjectNamespace.local({
				binding: "ENTITIES",
				className: "Entities",
			}),
		]),
		durableObjectNamespaces: [{ className: "Entities", sql: true }],
	},
	config("website-fixture-services", [{
		name: "index.js",
		type: "ESModule",
		content: await readFile("website/test/services.mjs", "utf8"),
	}], []),
	config("website-fixture-api", [
		{ name: "index.js", type: "ESModule", content: apiWrapper },
		{
			name: "api.js",
			type: "ESModule",
			content: await readFile("dist/api/index.js", "utf8"),
		},
	], [
		...authBindings(),
		Service.local({
			binding: "DOCUMENTS_ADMIN",
			scriptName: "website-documents",
			entrypoint: "DocumentsAdmin",
		}),
		Service.local({
			binding: "ENTITIES_ADMIN",
			scriptName: "website-entities",
			entrypoint: "EntitiesAdmin",
		}),
		Service.local({
			binding: "GOOGLE_ADMIN",
			scriptName: "website-fixture-services",
			entrypoint: "CalendarAdmin",
		}),
		Service.local({
			binding: "GITHUB_ADMIN",
			scriptName: "website-fixture-services",
			entrypoint: "GitHubAdmin",
		}),
	]),
	config("website-fixture", [
		{ name: "index.js", type: "ESModule", content: moduleWrapper },
		...build.serverModules.map(({ name, content }) => ({
			name,
			type: "ESModule",
			content,
		})),
	], [
		...authBindings(),
		Service.local({ binding: "API", scriptName: "website-fixture-api" }),
		Service.local({
			binding: "DOCUMENTS_ADMIN",
			scriptName: "website-documents",
			entrypoint: "DocumentsAdmin",
		}),
		Service.local({ binding: "OAUTH", scriptName: "website-fixture-services" }),
		Service.local({
			binding: "OAUTH_ADMIN",
			scriptName: "website-fixture-services",
			entrypoint: "OAuthAdmin",
		}),
		Service.local({
			binding: "GOOGLE_ADMIN",
			scriptName: "website-fixture-services",
			entrypoint: "CalendarAdmin",
		}),
	]),
];
const get = (path, headers = {}) =>
	fetch(origin + path, { headers, redirect: "manual" });
const post = (path, body, headers = {}) =>
	fetch(origin + path, {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/x-www-form-urlencoded",
			...headers,
		},
		body: new URLSearchParams(body),
		redirect: "manual",
	});
const queryGraphql = (query, variables = {}) =>
	fetch(origin + "/api/graphql", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
const exerciseDocuments = async () => {
	const path = "/api/documents/" + encodeURIComponent("daily:2000-01-01");
	const save = (note, expectedRevision, headers = {}) =>
		fetch(origin + path, {
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify({ note, expectedRevision }),
		});
	const note = (text) => ({
		type: "doc",
		content: [{ type: "paragraph", content: [{ type: "text", text }] }],
	});
	const homepage = await get("/");
	assert.equal(homepage.status, 200);
	const nonce = homepage.headers.get("content-security-policy")?.match(
		/'nonce-([^']+)'/,
	)?.[1];
	assert.ok(nonce, "Editor hydration must have a CSP nonce");
	const html = await homepage.text();
	const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
	assert.ok(scripts.length, "Editor page must contain hydration scripts");
	const eventPage = await get(
		"/events/" + encodeURIComponent("event:account:primary:series:event"),
	);
	assert.equal(eventPage.status, 200);
	assert.match(await eventPage.text(), /Meeting notes/);
	const seriesPage = await get(
		"/events/" +
			encodeURIComponent("event-series:account:primary:series"),
	);
	assert.equal(seriesPage.status, 200);
	assert.match(await seriesPage.text(), /Event series/);
	assert.ok(
		scripts.every((tag) => tag.includes(`nonce="${nonce}"`)),
		"All hydration scripts must carry the response nonce",
	);
	assert.deepEqual(await (await get(path)).json(), { document: null });
	assert.deepEqual(await (await get(path)).json(), { document: null });
	assert.equal(
		(await get(path, {
			"x-test-unauthenticated": "true",
			"X-E2-Owner": "access:website-owner",
		})).status,
		401,
	);
	assert.equal(
		(await save(note("Rejected"), null, { Origin: "https://attacker.test" }))
			.status,
		403,
	);
	assert.deepEqual(await (await get(path)).json(), { document: null });
	const created = await save(note("First edit"), null);
	assert.equal(created.status, 200);
	const { document } = await created.json();
	assert.deepEqual(document.note, note("First edit"));
	assert.equal(document.revision, 1);
	assert.deepEqual((await (await get(path)).json()).document, document);
	assert.deepEqual(
		await (await get(path, {
			"x-test-other-owner": "true",
			"X-E2-Owner": "access:website-owner",
		})).json(),
		{ document: null },
	);
	const writes = await Promise.all([
		save(note("Tab one"), 1),
		save(note("Tab two"), 1),
	]);
	assert.deepEqual(writes.map(({ status }) => status).sort(), [200, 409]);
	const latest = (await (await get(path)).json()).document;
	assert.equal(latest.revision, 2);
	assert.equal((await save(note("Stale initial tab"), null)).status, 409);
	assert.equal((await save({ type: "doc", content: [] }, 2)).status, 400);
	assert.equal(
		(await save(note("Invalid revision"), Number.MAX_SAFE_INTEGER)).status,
		400,
	);
	assert.deepEqual((await (await get(path)).json()).document, latest);
	const otherWrite = await save(note("Other owner note"), null, {
		"x-test-other-owner": "true",
		"X-E2-Owner": "access:website-owner",
	});
	assert.equal(otherWrite.status, 200);
	assert.equal((await otherWrite.json()).document.revision, 1);
	assert.deepEqual((await (await get(path)).json()).document, latest);
	const largePath = "/api/documents/runtime-large-note";
	const largeNote = {
		type: "doc",
		content: [{
			type: "paragraph",
			content: [{
				type: "component",
				attrs: {
					component: {
						id: "00000000-0000-4000-8000-000000000001",
						kind: "diagram",
						title: "Runtime chunk limit",
						source: "s".repeat(200_000),
						svg: "x".repeat(8 * 1024 * 1024),
					},
				},
			}],
		}, ...Array.from({ length: 19_000 }, () => ({ type: "paragraph" }))],
	};
	const largeSave = await fetch(origin + largePath, {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({ note: largeNote, expectedRevision: null }),
	});
	assert.equal(
		largeSave.status,
		200,
		"Notes above the SQLite row limit must save",
	);
	assert.deepEqual(
		(await (await get(largePath)).json()).document.note,
		largeNote,
	);
	const documentQuery = await fetch(origin + "/api/graphql", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({
			query:
				'query { me { document(id: "runtime-large-note") { id revision note } } }',
		}),
	});
	assert.equal(documentQuery.status, 200);
	const documentResult = await documentQuery.json();
	assert.equal(documentResult.errors, undefined);
	assert.deepEqual(documentResult.data.me.document.note, largeNote);
	console.log(
		"Documents runtime passed: empty reads, first-edit creation, persisted shared note, signed owner isolation, CSRF and concurrent compare-and-swap.",
	);
};
const exercise = async (urls) => {
	workerUrl = urls[4];
	await exerciseDocuments();
	assert.equal(
		(await get("/admin/oauth", {
			"x-test-unauthenticated": "true",
			"X-E2-Owner": "access:website-owner",
		})).status,
		401,
	);
	let response = await get("/admin/oauth");
	assert.equal(response.status, 200);
	assert.match(await response.text(), /No accounts connected/);
	response = await get("/admin/supertags");
	assert.equal(response.status, 200);
	assert.match(await response.text(), /Define inheritance and fields/);
	const supertags = await fetch(origin + "/api/graphql", {
		method: "POST",
		headers: { Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify({
			query: "query { me { supertags { id name kind rootId } } }",
		}),
	});
	assert.equal(supertags.status, 200);
	const supertagResult = await supertags.json();
	assert.equal(supertagResult.errors, undefined);
	assert.equal(
		supertagResult.data.me.supertags.filter(({ kind }) => kind === "base")
			.length,
		10,
	);
	assert.equal(
		supertagResult.data.me.supertags.find(({ name }) => name === "Person")
			?.kind,
		"base",
	);
	const createTag = await queryGraphql(
		`mutation RuntimeCreateTag($name: String!, $parentId: ID!) {
			createUserTag(input: { name: $name, parentId: $parentId }) {
				id name kind rootId revision
			}
		}`,
		{ name: "Colleague", parentId: "base:person" },
	);
	assert.equal(createTag.status, 200);
	const createdTag = (await createTag.json()).data.createUserTag;
	assert.equal(createdTag.kind, "user");
	assert.equal(createdTag.rootId, "base:person");
	const defineField = await queryGraphql(
		`mutation RuntimeDefineField($tagId: ID!) {
			defineEntityField(input: {
				tagId: $tagId
				key: "role"
				label: "Role"
				type: TEXT
				cardinality: SINGLE
			}) { id tagId key }
		}`,
		{ tagId: createdTag.id },
	);
	assert.equal(defineField.status, 200);
	assert.equal((await defineField.json()).data.defineEntityField.key, "role");
	const createEntity = await queryGraphql(
		`mutation RuntimeCreateEntity($tagId: ID!) {
			createEntity(input: {
				label: "Ada Lovelace"
				tagIds: [$tagId, "integration:google:contact"]
			}) {
				id label tagIds
			}
		}`,
		{ tagId: createdTag.id },
	);
	assert.equal(createEntity.status, 200);
	assert.equal(
		(await createEntity.json()).data.createEntity.label,
		"Ada Lovelace",
	);
	const searchEntities = await queryGraphql(
		`query RuntimeSearchEntities {
			me { entities(query: "Ada", rootId: "base:person", limit: 5) { label rootId } }
		}`,
	);
	assert.deepEqual((await searchEntities.json()).data.me.entities, [{
		label: "Ada Lovelace",
		rootId: "base:person",
	}]);
	const createGitHubEntity = await queryGraphql(
		`mutation RuntimeCreateGitHubEntity {
			createEntity(input: {
				label: "Ship canonical entities"
				tagIds: ["integration:github:issue"]
			}) { id label tagIds }
		}`,
	);
	assert.equal(createGitHubEntity.status, 200);
	assert.deepEqual(
		(await createGitHubEntity.json()).data.createEntity.tagIds,
		["integration:github:issue"],
	);
	assert.equal(
		(await post("/admin/accounts/action", {
			action: "sync",
			connectionId: "account",
		}, { Origin: "https://attacker.test" })).status,
		403,
	);
	response = await post("/admin/oauth/connect", { appId: "managed-google" });
	assert.equal(response.status, 303);
	assert.match(
		response.headers.get("set-cookie"),
		/e2-oauth-aaaaaaaaaaaaaaaaaaaaaaaa=/,
	);
	response = await get("/mock-consent");
	assert.equal(response.status, 303);
	assert.match(await (await get("/admin/oauth")).text(), /Enable sync/);
	assert.equal(
		(await post("/admin/accounts/action", {
			action: "sync",
			connectionId: "account",
		})).status,
		303,
	);
	const today = await queryGraphql(
		`query RuntimeToday($date: String!) {
			me { today(date: $date) {
				googleEvents { summary }
				googlePeople { displayName }
				githubActivity { title repository actor }
			} }
		}`,
		{ date: new Date().toISOString().slice(0, 10) },
	);
	assert.equal(today.status, 200);
	const todayResult = await today.json();
	assert.equal(todayResult.errors, undefined);
	assert.deepEqual(todayResult.data.me.today, {
		googleEvents: [{ summary: "Design review" }],
		googlePeople: [{ displayName: "Ada Lovelace" }],
		githubActivity: [{
			title: "Ship canonical entities",
			repository: "rawkode/rawkode",
			actor: "rawkode",
		}],
	});
	assert.match(
		await (await get("/admin/google?account=account")).text(),
		/Ada Lovelace/,
	);
	assert.match(
		await (await get("/admin/google?account=account&view=events")).text(),
		/Design review/,
	);
	const graphql = await fetch(origin + "/api/graphql", {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/json",
			"X-E2-Owner": "access:someone-else",
		},
		body: JSON.stringify({
			query:
				'query { me { id googleAccount(connectionId: "account") { contacts { records { displayName emails } } } } }',
		}),
	});
	assert.equal(graphql.status, 200);
	const result = await graphql.json();
	assert.equal(result.errors, undefined);
	assert.equal(result.data.me.id, "access:website-owner");
	assert.equal(
		result.data.me.googleAccount.contacts.records[0].displayName,
		"Ada Lovelace",
	);
	assert.match(
		await (await get("/admin/accounts/delete?account=account")).text(),
		/Delete david@example.test/,
	);
	response = await post("/admin/accounts/action", {
		action: "delete",
		connectionId: "account",
	});
	assert.match(response.headers.get("location"), /result=deleted/);
	assert.match(
		await (await get("/admin/oauth")).text(),
		/No accounts connected/,
	);
	console.log(
		"Website runtime passed: signed Access JWT, owner spoof rejection, CSRF, canonical Supertags/entities, Google and GitHub Today data, connect cookie, GraphQL proxy, and delete ordering.",
	);
	if (process.argv.includes("--serve")) {
		await post("/admin/oauth/connect", { appId: "managed-google" });
		await get("/mock-consent");
		await post("/admin/accounts/action", {
			action: "sync",
			connectionId: "account",
		});
		if (process.argv.includes("--dense")) {
			await fetch(new URL("/dense", urls[2]));
			const populated = await (await queryGraphql(
				`query { me { today(date: "${
					new Date().toISOString().slice(0, 10)
				}") { googleEvents { id } googlePeople { id } githubActivity { id } } } }`,
			)).json();
			assert.equal(populated.data.me.today.googleEvents.length, 7);
			assert.equal(populated.data.me.today.googlePeople.length, 23);
			assert.equal(populated.data.me.today.githubActivity.length, 30);
			console.log(
				"Dense context fixture passed: 7 events, 23 people, 30 GitHub activities.",
			);
		}
		console.log(`WEBSITE_BROWSER_URL=${origin}`);
		await new Promise((resolve) => process.once("SIGINT", resolve));
	}
};
try {
	await Runtime.pipe(
		Effect.flatMap((runtime) =>
			Effect.forEach(configs, (config) => runtime.start(config))
		),
		Effect.flatMap((urls) => Effect.promise(() => exercise(urls))),
		Effect.scoped,
		Effect.provide(localRuntime(join(temporary, "storage"))),
		Effect.provide(FetchHttpClient.layer),
		Effect.provide(NodeServices.layer),
		Effect.runPromise,
	);
} finally {
	await new Promise((resolve) => server.close(resolve));
	await rm(temporary, { recursive: true, force: true });
}
