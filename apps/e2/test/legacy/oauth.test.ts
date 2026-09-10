import {
	after as afterAll,
	afterEach,
	before as beforeAll,
	beforeEach,
	describe,
	test,
} from "node:test";
import { expect } from "expect";
import { setTimeout as delay } from "node:timers/promises";
import { startMockGoogle } from "./mock-google.ts";
import { testDatabase } from "./d1.ts";
import { AdminApi } from "../../integrations/oauth/src/admin.ts";
import {
	authenticateService,
	IntegrationApi,
} from "../../integrations/oauth/src/tokens.ts";
import {
	bindingCookieName,
	callback,
} from "../../integrations/oauth/src/callback.ts";
import {
	createTokenVault,
	randomSecret,
	sha256,
} from "../../integrations/oauth/src/crypto.ts";
import { provider } from "../../integrations/oauth/src/providers.ts";
import type { OAuthEnv } from "../../integrations/oauth/src/env.ts";
import { syncCalendar } from "../../integrations/google/src/sync.ts";
import { syncGoogle } from "../../integrations/google/src/mirror.ts";
import {
	receiveMailNotification,
	searchMail,
	watchMail,
} from "../../integrations/google/src/gmail.ts";
import type { CalendarEnv } from "../../integrations/google/src/env.ts";
import { scopes } from "../../integrations/google/src/google.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const scope = "https://www.googleapis.com/auth/calendar.readonly";
let mock: Awaited<ReturnType<typeof startMockGoogle>>;
let storage: Awaited<ReturnType<typeof testDatabase>>;
let env: OAuthEnv;
let admin: AdminApi;
let integration: IntegrationApi;
const credential = "calendar-test-credential-01234567890123456789";
beforeAll(async () => {
	mock = await startMockGoogle(0);
});
afterAll(() => mock.server.shutdown());
beforeEach(async () => {
	storage = await testDatabase(
		"../../integrations/oauth/migrations",
	);
	env = {
		DB: storage.db,
		WEBSITE_ORIGIN: "http://localhost:4321",
		LOCAL_PROVIDER_ORIGIN: mock.origin,
		TOKEN_KEYRING: {
			get: () =>
				Promise.resolve(
					JSON.stringify({
						active: "test",
						keys: { test: btoa("a".repeat(32)) },
					}),
				),
		},
		GOOGLE_SERVICE_CREDENTIAL: { get: () => Promise.resolve(credential) },
		GITHUB_SERVICE_CREDENTIAL: {
			get: () =>
				Promise.resolve("unused-github-credential-01234567890123456789"),
		},
	};
	admin = new AdminApi(env, "owner-a");
	integration = new IntegrationApi(env, credential);
	await control({
		revision: 1,
		rejectRefresh: false,
		failSecondPage: false,
		shortTokens: false,
		omitRotatedRefresh: false,
		refreshDelayMs: 0,
	});
});
afterEach(() => storage.sqlite.close());

const control = async (body: Record<string, unknown>) => {
	await fetch(`${mock.origin}/__test/control`, {
		method: "POST",
		body: JSON.stringify(body),
	});
};
const refreshCount = async () => {
	return (await (await fetch(`${mock.origin}/__test/status`)).json() as {
		refreshCount: number;
	}).refreshCount;
};
const app = (requested = [scope]) => {
	return admin.createApp({
		name: "Calendar",
		providerId: "google",
		clientId: "test-client",
		clientSecret: "test-secret",
		scopes: requested,
	});
};
const flow = async (requested = [scope]) => {
	const application = await app(requested);
	const binding = randomSecret();
	const started = await admin.beginConnection({
		appId: application.id,
		browserBindingHash: await sha256(binding),
	});
	const authorize = new URL(started.authorizationUrl);
	authorize.searchParams.set("approve", "yes");
	const authorization = await fetch(authorize, { redirect: "manual" });
	const url = authorization.headers.get("Location")!;
	const cookie = `${bindingCookieName(started.stateId, false)}=${binding}`;
	return { application, started, url, cookie };
};
const connected = async (grant = true) => {
	const f = await flow();
	const response = await callback(
		new Request(f.url, { headers: { Cookie: f.cookie } }),
		env,
	);
	expect(response.headers.get("Location")).toMatch(/result=connected$/);
	const connection = (await admin.listConnections())[0];
	if (grant) await admin.grantService(connection.id, "integrations-google");
	return connection;
};

describe("OAuth credentials and connection flow", () => {
	test("encrypts secrets, authenticates row identity, and supports old keys during rotation", async () => {
		const created = await app();
		expect(JSON.stringify(created)).not.toContain("test-secret");
		expect(JSON.stringify(await admin.listApps())).not.toContain(
			"client_secret",
		);
		const ciphertext =
			(storage.sqlite.query("SELECT client_secret FROM oauth_apps").get() as {
				client_secret: string;
			}).client_secret;
		expect(ciphertext).toMatch(/^v1\.test\./);
		const vault = createTokenVault(env);
		expect(await vault.decrypt(ciphertext, `app:${created.id}:secret`)).toBe(
			"test-secret",
		);
		await expect(vault.decrypt(ciphertext, "app:other:secret")).rejects
			.toThrow();
		const rotated = createTokenVault({
			TOKEN_KEYRING: {
				get: () =>
					Promise.resolve(
						JSON.stringify({
							active: "next",
							keys: { test: btoa("a".repeat(32)), next: btoa("b".repeat(32)) },
						}),
					),
			},
		});
		expect(await rotated.decrypt(ciphertext, `app:${created.id}:secret`)).toBe(
			"test-secret",
		);
		expect(await rotated.encrypt("token", "row")).toMatch(/^v1\.next\./);
	});
	test("validates runtime input and rejects unknown providers and production test endpoints", async () => {
		await expect(
			admin.createApp({
				name: "",
				providerId: "google",
				clientId: "id",
				clientSecret: "secret",
				scopes: [scope],
			}),
		).rejects.toThrow("app name");
		await expect(
			admin.createApp({
				name: "App",
				providerId: "custom",
				clientId: "id",
				clientSecret: "secret",
				scopes: [scope],
			}),
		).rejects.toThrow("not supported");
		expect(() =>
			provider("google", { ...env, WEBSITE_ORIGIN: "https://example.com" })
		).toThrow("loopback");
	});
	test("binds the flow to its browser, consumes state once, and encrypts tokens", async () => {
		const f = await flow();
		expect(
			new URL(f.started.authorizationUrl).searchParams.get(
				"code_challenge_method",
			),
		).toBe("S256");
		expect((await callback(new Request(f.url), env)).status).toBe(400);
		expect(
			(await callback(
				new Request(f.url, { headers: { Cookie: f.cookie + "wrong" } }),
				env,
			)).status,
		).toBe(400);
		const request = new Request(f.url, { headers: { Cookie: f.cookie } });
		expect((await callback(request, env)).headers.get("Location")).toMatch(
			/result=connected$/,
		);
		expect((await callback(request, env)).status).toBe(400);
		const row = storage.sqlite.query(
			"SELECT access_token, refresh_token FROM oauth_connections",
		).get() as { access_token: string; refresh_token: string };
		expect(row.access_token).toMatch(/^v1\.test\./);
		expect(row.refresh_token).toMatch(/^v1\.test\./);
		const metadata = JSON.stringify(await admin.listConnections());
		expect(metadata).not.toContain(row.access_token);
		expect(metadata).not.toContain(row.refresh_token);
	});
	test("rejects expired state, wrong provider routes, and OIDC nonce mismatches", async () => {
		const f = await flow();
		const wrong = new Request(
			f.url.replace("/callback/google", "/callback/other"),
			{ headers: { Cookie: f.cookie } },
		);
		expect((await callback(wrong, env)).status).toBe(400);
		storage.sqlite.exec("UPDATE oauth_sessions SET nonce = 'incorrect-nonce'");
		expect(
			(await callback(
				new Request(f.url, { headers: { Cookie: f.cookie } }),
				env,
			)).headers.get("Location"),
		).toMatch(/result=failed$/);
		expect(await admin.listConnections()).toHaveLength(0);
		const expired = await flow();
		storage.sqlite.exec("UPDATE oauth_sessions SET expires_at = 0");
		expect(
			(await callback(
				new Request(expired.url, { headers: { Cookie: expired.cookie } }),
				env,
			)).status,
		).toBe(400);
	});
	test("handles denied consent without exchanging a code", async () => {
		const f = await flow();
		const denied = new URL(f.url);
		denied.searchParams.delete("code");
		denied.searchParams.set("error", "access_denied");
		const response = await callback(
			new Request(denied, { headers: { Cookie: f.cookie } }),
			env,
		);
		expect(response.headers.get("Location")).toMatch(/result=cancelled$/);
		expect(await admin.listConnections()).toHaveLength(0);
		expect(
			(await callback(
				new Request(f.url, { headers: { Cookie: f.cookie } }),
				env,
			)).status,
		).toBe(400);
	});
});

describe("integration token authority and refresh", () => {
	test("requires service authentication, explicit grants, ownership, and granted scopes", async () => {
		const c = await connected(false);
		await expect(authenticateService(env, "wrong")).rejects.toThrow(
			"Unauthorized",
		);
		expect(await integration.listConnections()).toHaveLength(0);
		await expect(integration.getAccessToken(c.id, [scope])).rejects.toThrow(
			"not authorized",
		);
		const other = new AdminApi(env, "owner-b");
		expect(await other.listConnections()).toHaveLength(0);
		await expect(other.grantService(c.id, "integrations-google")).rejects
			.toThrow(
				"not found",
			);
		await expect(other.disconnect(c.id)).rejects.toThrow("not found");
		await admin.grantService(c.id, "integrations-google");
		await expect(
			integration.getAccessToken(c.id, [
				"https://www.googleapis.com/auth/gmail.readonly",
			]),
		).rejects.toThrow("required scopes");
		const token = await integration.getAccessToken(c.id, [scope]);
		expect(token.tokenType).toBe("Bearer");
		expect(token.scopes).toContain(scope);
		expect(JSON.stringify(token)).not.toContain("refresh");
		await admin.revokeService(c.id, "integrations-google");
		await expect(integration.getAccessToken(c.id, [scope])).rejects.toThrow(
			"not authorized",
		);
	});
	test("serializes concurrent refreshes across callers and stores rotated refresh tokens", async () => {
		const c = await connected();
		const previous =
			(storage.sqlite.query("SELECT refresh_token FROM oauth_connections")
				.get() as { refresh_token: string }).refresh_token;
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		const before = await refreshCount();
		const results = await Promise.all([
			integration.getAccessToken(c.id, [scope]),
			new IntegrationApi(env, credential).getAccessToken(c.id, [scope]),
			integration.getAccessToken(c.id, [scope]),
		]);
		expect(new Set(results.map((item) => item.accessToken)).size).toBe(1);
		expect(await refreshCount()).toBe(before + 1);
		expect(
			(storage.sqlite.query("SELECT refresh_token FROM oauth_connections")
				.get() as { refresh_token: string }).refresh_token,
		).not.toBe(previous);
	});
	test("preserves omitted refresh tokens and marks invalid grants for reconnection", async () => {
		const c = await connected();
		const previous =
			(storage.sqlite.query("SELECT refresh_token FROM oauth_connections")
				.get() as { refresh_token: string }).refresh_token;
		await control({ omitRotatedRefresh: true });
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		await integration.getAccessToken(c.id, [scope]);
		expect(
			(storage.sqlite.query("SELECT refresh_token FROM oauth_connections")
				.get() as { refresh_token: string }).refresh_token,
		).toBe(previous);
		await control({ rejectRefresh: true });
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		await expect(integration.getAccessToken(c.id, [scope])).rejects.toThrow(
			"Reconnect",
		);
		const row = storage.sqlite.query(
			"SELECT status, access_token, refresh_token FROM oauth_connections",
		).get();
		expect(row).toEqual({
			status: "reconnect_required",
			access_token: null,
			refresh_token: null,
		});
	});
	test("disconnect removes stored credentials and grants", async () => {
		const c = await connected();
		await admin.disconnect(c.id);
		expect(await integration.listConnections()).toHaveLength(0);
		expect(storage.sqlite.query("SELECT * FROM oauth_service_grants").all())
			.toHaveLength(0);
		await expect(integration.getAccessToken(c.id, [scope])).rejects.toThrow(
			"not authorized",
		);
	});
	test("does not return a token or recreate credentials when disconnected during refresh", async () => {
		const c = await connected();
		await control({ refreshDelayMs: 100 });
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		const before = await refreshCount();
		const pending = integration.getAccessToken(c.id, [scope]).then(
			() => null,
			(error: Error) => error,
		);
		while (await refreshCount() === before) await delay(5);
		await admin.disconnect(c.id);
		expect((await pending)?.message).toContain("Connection changed");
		expect(storage.sqlite.query("SELECT * FROM oauth_connections").all())
			.toHaveLength(0);
	});
	test("rejects the old service credential when it rotates during a pending refresh", async () => {
		const c = await connected();
		await control({ refreshDelayMs: 100 });
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		const before = await refreshCount();
		const pending = integration.getAccessToken(c.id, [scope]).then(
			() => null,
			(error: Error) => error,
		);
		while (await refreshCount() === before) await delay(5);
		env.GOOGLE_SERVICE_CREDENTIAL = {
			get: () =>
				Promise.resolve("rotated-google-credential-01234567890123456789"),
		};
		expect((await pending)?.message).toContain("Unauthorized integration");
		expect(await admin.listConnections()).toHaveLength(1);
	});

	test("rechecks a removed service grant before returning a refreshed token", async () => {
		const c = await connected();
		await control({ refreshDelayMs: 100 });
		storage.sqlite.exec("UPDATE oauth_connections SET expires_at = 0");
		const before = await refreshCount();
		const pending = integration.getAccessToken(c.id, [scope]).then(
			() => null,
			(error: Error) => error,
		);
		while (await refreshCount() === before) await delay(5);
		await admin.revokeService(c.id, "integrations-google");
		expect((await pending)?.message).toContain("not authorized");
		expect(await admin.listConnections()).toHaveLength(1);
	});
});

describe("calendar sync against its own database", () => {
	test("Google mirror handles multiple calendars, contact tombstones, resumable pages and live Gmail without a message table", async () => {
		const f = await flow(Object.values(scopes));
		await callback(new Request(f.url, { headers: { Cookie: f.cookie } }), env);
		const c = (await admin.listConnections())[0];
		await admin.grantService(c.id, "integrations-google");
		const google = await testDatabase(
			"../../integrations/google/migrations",
		);
		const notifications: string[] = [];
		const accounts = {
			getByName: () => ({
				notifyMail: (_id: string, _email: string, history: string) => {
					notifications.push(history);
					return Promise.resolve();
				},
			}),
		} as unknown as CalendarEnv["GOOGLE_ACCOUNTS"];
		const googleEnv = {
			GOOGLE_ACCOUNTS: accounts,
			DB: google.db,
			OAUTH: {
				authorize: () =>
					Promise.resolve(
						Object.assign(integration, { [Symbol.dispose]: () => {} }),
					),
			},
			OAUTH_SERVICE_CREDENTIAL: { get: () => Promise.resolve(credential) },
			LOCAL_PROVIDER_ORIGIN: mock.origin,
			GMAIL_PUBSUB_TOPIC: "projects/local/topics/gmail",
		};
		try {
			expect((await syncGoogle(googleEnv, integration, c)).pending).toBe(true);
			expect(
				google.sqlite.query(
					"SELECT * FROM google_records WHERE collection = 'events:primary'",
				).all(),
			).toHaveLength(0);
			expect(
				google.sqlite.query(
					"SELECT * FROM google_records WHERE collection = 'events:work'",
				).all(),
			).toHaveLength(1);
			await control({ failSecondPage: true });
			await expect(syncGoogle(googleEnv, integration, c)).rejects.toThrow();
			expect(
				google.sqlite.query(
					"SELECT page_token FROM google_syncs WHERE collection = 'events:primary'",
				).get(),
			).toEqual({ page_token: "page-2" });
			await control({ failSecondPage: false });
			await syncGoogle(googleEnv, integration, c);
			expect(
				google.sqlite.query(
					"SELECT * FROM google_records WHERE collection LIKE 'events:%' AND deleted = 0",
				).all(),
			).toHaveLength(3);
			await control({ revision: 2 });
			await syncGoogle(googleEnv, integration, c);
			await syncGoogle(googleEnv, integration, c);
			expect(
				google.sqlite.query(
					"SELECT deleted FROM google_records WHERE resource_id = 'people/deleted'",
				).get(),
			).toEqual({ deleted: 1 });
			expect(
				google.sqlite.query(
					"SELECT * FROM google_records WHERE collection = 'events:primary' AND deleted = 0",
				).all(),
			).toHaveLength(1);
			await control({ revision: 3 });
			await syncGoogle(googleEnv, integration, c);
			await syncGoogle(googleEnv, integration, c);
			expect(
				google.sqlite.query(
					"SELECT sync_token FROM google_syncs WHERE collection = 'contacts'",
				).get(),
			).toEqual({ sync_token: "people-3" });
			expect(
				(await searchMail(googleEnv, integration, c, "from:alex")).messages,
			).toHaveLength(1);
			expect((await watchMail(googleEnv, integration, c)).expiration)
				.toBeGreaterThan(Date.now());
			expect(
				google.sqlite.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%message%'",
				).all(),
			).toHaveLength(0);
			const pushEnv = {
				...googleEnv,
				GMAIL_PUSH_AUDIENCE: "https://example.test/gmail/notifications",
				GMAIL_PUSH_SERVICE_ACCOUNT: "push@example.test",
				GMAIL_PUSH_SUBSCRIPTION: "projects/local/subscriptions/gmail",
			};
			expect(
				(await receiveMailNotification(
					new Request("https://example.test/gmail/notifications", {
						method: "POST",
						body: "{}",
					}),
					pushEnv,
					integration,
				)).status,
			).toBe(401);
			const pushKeys = await generateKeyPair("RS256", { extractable: true });
			const pushJwk = {
				...await exportJWK(pushKeys.publicKey),
				kid: "push-test",
				alg: "RS256",
				use: "sig",
			};
			const originalFetch = globalThis.fetch;
			globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
				String(input) === "https://www.googleapis.com/oauth2/v3/certs"
					? Promise.resolve(Response.json({ keys: [pushJwk] }))
					: originalFetch(input, init)) as typeof fetch;
			try {
				const assertion = await new SignJWT({
					email: pushEnv.GMAIL_PUSH_SERVICE_ACCOUNT,
					email_verified: true,
				}).setProtectedHeader({ alg: "RS256", kid: "push-test" }).setIssuer(
					"https://accounts.google.com",
				).setSubject("push-service").setAudience(pushEnv.GMAIL_PUSH_AUDIENCE)
					.setIssuedAt().setExpirationTime("1h").sign(pushKeys.privateKey);
				const push = (
					historyId: string,
					subscription = pushEnv.GMAIL_PUSH_SUBSCRIPTION,
				) =>
					new Request(pushEnv.GMAIL_PUSH_AUDIENCE, {
						method: "POST",
						headers: { Authorization: `Bearer ${assertion}` },
						body: JSON.stringify({
							subscription,
							message: {
								data: btoa(
									JSON.stringify({
										emailAddress: "alex@example.test",
										historyId,
									}),
								),
							},
						}),
					});
				expect(
					(await receiveMailNotification(
						push("12345678901234567899"),
						pushEnv,
						integration,
					)).status,
				).toBe(204);
				expect(
					(await receiveMailNotification(
						push("12345678901234567891"),
						pushEnv,
						integration,
					)).status,
				).toBe(204);
				expect(
					notifications,
				).toEqual(["12345678901234567899", "12345678901234567891"]);
				expect(
					(await receiveMailNotification(
						push("12345678901234567900", "wrong"),
						pushEnv,
						integration,
					)).status,
				).toBe(400);
			} finally {
				globalThis.fetch = originalFetch;
			}
			await admin.revokeService(c.id, "integrations-google");
			await expect(searchMail(googleEnv, integration, c, "")).rejects.toThrow(
				"not authorized",
			);
			await expect(syncGoogle(googleEnv, integration, c)).rejects.toThrow(
				"not authorized",
			);
		} finally {
			google.sqlite.close();
		}
	});
	test("handles pagination, updates, deletions, expired cursors, and page failures atomically", async () => {
		const c = await connected();
		const calendar = await testDatabase(
			"../../integrations/google/migrations",
		);
		try {
			const calendarEnv = {
				GOOGLE_ACCOUNTS: {
					getByName: () => {
						throw new Error("Unexpected account RPC");
					},
				} as unknown as CalendarEnv["GOOGLE_ACCOUNTS"],
				DB: calendar.db,
				OAUTH: {
					authorize: () =>
						Promise.resolve(
							Object.assign(integration, { [Symbol.dispose]: () => {} }),
						),
				},
				OAUTH_SERVICE_CREDENTIAL: { get: () => Promise.resolve(credential) },
				LOCAL_PROVIDER_ORIGIN: mock.origin,
			};
			expect((await syncCalendar(calendarEnv, integration, c)).changed).toBe(2);
			expect(calendar.sqlite.query("SELECT * FROM calendar_events").all())
				.toHaveLength(2);
			const before = calendar.sqlite.query(
				"SELECT synced_at, sync_token FROM calendar_syncs",
			).get();
			await control({ revision: 2, failSecondPage: true });
			await expect(syncCalendar(calendarEnv, integration, c)).rejects.toThrow(
				"could not be synced",
			);
			expect(
				calendar.sqlite.query(
					"SELECT synced_at, sync_token FROM calendar_syncs",
				).get(),
			).toEqual(before);
			expect(calendar.sqlite.query("SELECT * FROM calendar_events").all())
				.toHaveLength(2);
			await control({ failSecondPage: false });
			await syncCalendar(calendarEnv, integration, c);
			expect(calendar.sqlite.query("SELECT * FROM calendar_events").all())
				.toHaveLength(1);
			expect(
				(calendar.sqlite.query("SELECT data FROM calendar_events").get() as {
					data: string;
				}).data,
			).toContain("updated");
			await control({ revision: 3 });
			await syncCalendar(calendarEnv, integration, c);
			expect(
				calendar.sqlite.query("SELECT sync_token FROM calendar_syncs").get(),
			).toEqual({ sync_token: "sync-3" });
			expect(calendar.sqlite.query("SELECT * FROM calendar_staging").all())
				.toHaveLength(0);
			expect(
				storage.sqlite.query(
					"SELECT name FROM sqlite_master WHERE name = 'calendar_events'",
				).get(),
			).toBeNull();
		} finally {
			calendar.sqlite.close();
		}
	});
});
