import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTokenVault } from "../integrations/oauth/src/crypto.ts";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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
const { D1, Text, Service, DurableObjectNamespace, SecretsStore } =
	await runtimeImport(
		"core/bindings",
	);
const temporary = await mkdtemp(join(tmpdir(), "e2-smoke-"));
// Isolate the local service registry; this test never discovers running user Workers.
for (const kind of ["CACHE", "CONFIG", "DATA", "STATE"]) {
	process.env[`XDG_${kind}_HOME`] = join(temporary, kind.toLowerCase());
}
const googleCredential = randomBytes(32).toString("hex");
const githubCredential = randomBytes(32).toString("hex");
const secretValues = {
	"google-client-id": "managed-google-client",
	"google-client-secret": "managed-google-secret",
	google: googleCredential,
	github: githubCredential,
	keyring: JSON.stringify({
		active: "primary",
		keys: { primary: randomBytes(32).toString("base64") },
	}),
};
const tokenFixture = await createTokenVault({
	TOKEN_KEYRING: { get: () => Promise.resolve(secretValues.keyring) },
}).encrypt("e2-smoke-google-token", "connection:account:access");
const providerState = { hold: false, release: undefined };
const provider = createServer((request, response) => {
	if (request.headers.authorization !== "Bearer e2-smoke-google-token") {
		response.writeHead(401).end();
		return;
	}
	const path = new URL(request.url, "http://localhost").pathname;
	if (path.startsWith("/control/")) {
		if (path === "/control/hold") providerState.hold = true;
		if (path === "/control/release") {
			providerState.release?.();
			providerState.release = undefined;
			providerState.hold = false;
		}
		response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({ pending: Boolean(providerState.release) }),
		);
		return;
	}
	const body = path === "/v1/people/me/connections"
		? {
			connections: [{
				resourceName: "people/contact",
				names: [{ displayName: "Smoke Contact" }],
			}],
			nextSyncToken: "contacts-cursor",
		}
		: path === "/calendar/v3/users/me/calendarList"
		? {
			items: [{
				id: "primary",
				summary: "Smoke Calendar",
				accessRole: "owner",
			}],
			nextSyncToken: "calendars-cursor",
		}
		: path === "/calendar/v3/calendars/primary/events"
		? {
			items: [{
				id: "event",
				summary: "Smoke Event",
				start: { dateTime: "2026-09-10T12:00:00Z" },
				end: { dateTime: "2026-09-10T13:00:00Z" },
			}],
			nextSyncToken: "events-cursor",
		}
		: null;
	const send = () =>
		response.writeHead(body ? 200 : 404, { "Content-Type": "application/json" })
			.end(JSON.stringify(body));
	if (providerState.hold && path === "/v1/people/me/connections") {
		providerState.release = send;
	} else send();
});
await new Promise((resolve, reject) => {
	provider.once("error", reject);
	provider.listen(0, "127.0.0.1", resolve);
});
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
const secretBinding = (binding, secretName) =>
	SecretsStore.local({ binding, storeId: "e2-smoke", secretName });
const textBindings = (values) =>
	Object.entries(values).map(([name, value]) => Text.local(name, value));
const oauthBinding = () =>
	Service.local({
		binding: "OAUTH",
		scriptName: "integrations-oauth",
		entrypoint: "OAuthIntegrations",
	});
const modules = async (name) =>
	Promise.all(
		(await readdir(resolve("dist", name), {
			recursive: true,
			withFileTypes: true,
		}))
			.filter((entry) => entry.isFile() && /\.(js|sql)$/.test(entry.name))
			.map(async (entry) => {
				const path = join(entry.parentPath, entry.name);
				return {
					name: path.slice(resolve("dist", name).length + 1),
					type: entry.name.endsWith(".sql") ? "Text" : "ESModule",
					content: await readFile(path, "utf8"),
				};
			}),
	);
const compatibility = async (name) => {
	const { workerSource } = await import(
		new URL(
			`../integrations/${name.replace("integrations-", "")}/alchemy.ts`,
			import.meta.url,
		)
	);
	return {
		compatibilityDate: workerSource.compatibility.date,
		compatibilityFlags: workerSource.compatibility.flags,
	};
};
const worker = async (name, bindings, extra = {}) => ({
	name,
	...await compatibility(name),
	modules: await modules(name),
	bindings,
	...extra,
});
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwks = {
	keys: [{ ...await exportJWK(publicKey), kid: "api-smoke", alg: "RS256" }],
};
const accessToken = (subject) =>
	new SignJWT({ email: "david@rawkode.academy" }).setProtectedHeader({
		alg: "RS256",
		kid: "api-smoke",
	}).setSubject(subject).setIssuer("https://test.cloudflareaccess.com")
		.setAudience("api-smoke").setIssuedAt().setExpirationTime("1h").sign(
			privateKey,
		);
const apiBindings = [
	...textBindings({
		WEBSITE_ORIGIN: "http://localhost:4321",
		ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
		ACCESS_AUDIENCE: "api-smoke",
		ADMIN_EMAILS: "david@rawkode.academy",
	}),
	Service.local({
		binding: "GOOGLE_ADMIN",
		scriptName: "integrations-google",
		entrypoint: "CalendarAdmin",
	}),
	Service.local({
		binding: "GITHUB_ADMIN",
		scriptName: "integrations-github",
		entrypoint: "GitHubAdmin",
	}),
];
const apiWrapper = `import api from './api.js';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input) === 'https://test.cloudflareaccess.com/cdn-cgi/access/certs' ? Promise.resolve(Response.json(${
	JSON.stringify(jwks)
})) : nativeFetch(input, init);
export default api;`;
const configs = [
	await worker("integrations-oauth", [
		D1.local({ binding: "DB", id: "oauth" }),
		...textBindings({
			WEBSITE_ORIGIN: "http://localhost:4321",
		}),
		secretBinding("TOKEN_KEYRING", "keyring"),
		secretBinding("GOOGLE_CLIENT_ID", "google-client-id"),
		secretBinding("GOOGLE_CLIENT_SECRET", "google-client-secret"),
		secretBinding("GOOGLE_SERVICE_CREDENTIAL", "google"),
		secretBinding("GITHUB_SERVICE_CREDENTIAL", "github"),
	]),
	await worker("integrations-google", [
		...textBindings({ LOCAL_PROVIDER_ORIGIN: providerOrigin }),
		oauthBinding(),
		secretBinding("OAUTH_SERVICE_CREDENTIAL", "google"),
		DurableObjectNamespace.local({
			binding: "GOOGLE_ACCOUNTS",
			className: "GoogleAccount",
		}),
	], { durableObjectNamespaces: [{ className: "GoogleAccount", sql: true }] }),
	await worker("integrations-github", [
		oauthBinding(),
		secretBinding("OAUTH_SERVICE_CREDENTIAL", "github"),
	]),
	{
		name: "e2-smoke-gateway",
		...await compatibility("integrations-oauth"),
		modules: [{
			name: "index.js",
			type: "ESModule",
			content: await readFile("test/runtime/gateway.mjs", "utf8"),
		}],
		bindings: [
			SecretsStore.admin({ binding: "SECRET_STORE", storeId: "e2-smoke" }),
			Service.local({ binding: "API", scriptName: "e2-api" }),
			oauthBinding(),
			Service.local({
				binding: "OAUTH_ADMIN",
				scriptName: "integrations-oauth",
				entrypoint: "OAuthAdmin",
			}),
			Service.local({
				binding: "GOOGLE_ADMIN",
				scriptName: "integrations-google",
				entrypoint: "CalendarAdmin",
			}),
			Service.local({
				binding: "GITHUB_ADMIN",
				scriptName: "integrations-github",
				entrypoint: "GitHubAdmin",
			}),
			D1.local({ binding: "OAUTH_DB", id: "oauth" }),
			DurableObjectNamespace.local({
				binding: "GOOGLE_ACCOUNTS",
				scriptName: "integrations-google",
				className: "GoogleAccount",
			}),
			...textBindings({
				GOOGLE_CREDENTIAL: googleCredential,
				API_ASSERTION: await accessToken("alice"),
				OTHER_API_ASSERTION: await accessToken("bob"),
				TOKEN_FIXTURE: tokenFixture,
				PROVIDER_ORIGIN: providerOrigin,
				SECRET_FIXTURES: JSON.stringify(secretValues),
				ROTATED_GOOGLE_CREDENTIAL: randomBytes(32).toString("hex"),
			}),
		],
	},
	{
		name: "e2-api",
		...await compatibility("integrations-google"),
		modules: [{ name: "index.js", type: "ESModule", content: apiWrapper }, {
			name: "api.js",
			type: "ESModule",
			content: await readFile(resolve("dist/api/index.js"), "utf8"),
		}],
		bindings: apiBindings,
	},
];
// Exercise the same migration loader, SQL application, and bookkeeping as D1 deploy.
const { runMigrations, MigrationError } = await import(
	new URL("./SQL/Migrations/index.js", import.meta.resolve("alchemy"))
);
const applyMigrations = async (gateway, worker, database) => {
	const execute = (operation) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(
					new URL(`/migrations/${database}`, gateway),
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(operation),
					},
				);
				const result = await response.json();
				if (!response.ok) {
					throw new Error(result.error ?? "D1 migration execution failed");
				}
				return result;
			},
			catch: (cause) =>
				new MigrationError({
					message: `Local ${database} D1 execution failed`,
					cause,
				}),
		});
	const executor = {
		dialect: "sqlite",
		query: (sql, params = []) => execute({ sql, params }),
		batch: (statements) => execute({ statements }).pipe(Effect.asVoid),
	};
	const apply = () =>
		runMigrations({
			input: {
				dir: resolve(
					`integrations/${worker.replace("integrations-", "")}/migrations`,
				),
			},
			stamped: {},
			withExecutor: (run) => run(executor),
		}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
	await apply();
	const before = await Effect.runPromise(
		executor.query("SELECT * FROM __alchemy_migrations ORDER BY id"),
	);
	assert.ok(before.length > 0, `${worker}: Alchemy applied no migrations`);
	await apply();
	assert.deepEqual(
		await Effect.runPromise(
			executor.query("SELECT * FROM __alchemy_migrations ORDER BY id"),
		),
		before,
	);
	console.log(
		`${worker}: Alchemy applied Drizzle migrations and second apply was a no-op`,
	);
};
const exercise = async (urls) => {
	await applyMigrations(urls[3], "integrations-oauth", "oauth");
	for (
		const [index, name] of [
			"integrations-oauth",
			"integrations-google",
			"integrations-github",
		].entries()
	) {
		const response = await fetch(new URL("/health", urls[index]));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { service: name, status: "ok" });
		const privateRoute = await fetch(new URL("/rpc", urls[index]), {
			method: "POST",
			headers: { "X-E2-Owner": "alice", "Connection": "close" },
		});
		assert.equal(
			privateRoute.status,
			404,
			`${name}: private RPC exposed on default entrypoint`,
		);
		await privateRoute.text();
		console.log(`${name}: health and public RPC isolation passed`);
	}
	const response = await fetch(urls[3]);
	const result = await response.json();
	assert.equal(response.status, 200, JSON.stringify(result));
	assert.equal(result.ok, true);
	console.log(`Worker runtime smoke passed: ${result.checks.join(", ")}`);
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
	provider.closeAllConnections();
	await new Promise((resolve) => provider.close(resolve));
	await rm(temporary, { recursive: true, force: true });
}
