// Test-only local gateway: never bundled into any deployed Worker.
const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};
const rejects = async (action, message) => {
	try {
		await action();
	} catch {
		return;
	}
	throw new Error(message);
};
export default {
	fetch: async (request, env) => {
		const path = new URL(request.url).pathname;
		if (
			request.method === "POST" &&
			path === "/migrations/oauth"
		) {
			try {
				const db = env.OAUTH_DB;
				const { sql, params, statements } = await request.json();
				if (statements) {
					await db.batch(statements.map((statement) => db.prepare(statement)));
					return Response.json(null);
				}
				const result = await db.prepare(sql).bind(...params).all();
				return Response.json(result.results);
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		try {
			for (
				const [name, value] of Object.entries(JSON.parse(env.SECRET_FIXTURES))
			) {
				await env.SECRET_STORE.put(name, value);
			}
			const scope = "https://www.googleapis.com/auth/calendar.readonly";
			const grantedScopes = [
				scope,
				"https://www.googleapis.com/auth/contacts.readonly",
			];
			await env.OAUTH_DB.batch([
				env.OAUTH_DB.prepare(
					"INSERT INTO oauth_apps(id,name,provider_id,client_id,client_secret,scopes,created_at) VALUES ('app','Test','google','test','unused',?,0)",
				).bind(JSON.stringify(grantedScopes)),
				env.OAUTH_DB.prepare(
					"INSERT INTO oauth_connections(id,app_id,owner_id,account_id,account_label,scopes,created_at) VALUES ('account','app','access:alice','account','alice@example.com',?,0)",
				).bind(JSON.stringify(grantedScopes)),
			]);
			await env.OAUTH_DB.prepare(
				"UPDATE oauth_connections SET access_token = ?, expires_at = ? WHERE id = 'account'",
			).bind(env.TOKEN_FIXTURE, Date.now() + 3600000).run();
			await rejects(
				() => env.OAUTH.authorize("invalid"),
				"Invalid service credential was accepted",
			);
			using integration = await env.OAUTH.authorize(env.GOOGLE_CREDENTIAL);
			assert(
				(await integration.listConnections()).length === 0,
				"Connection visible without grant",
			);
			using owner = await env.OAUTH_ADMIN.admin("access:alice");
			using other = await env.OAUTH_ADMIN.admin("access:bob");
			const managed = (await owner.listApps()).find((app) =>
				app.id === "google"
			);
			assert(
				managed?.clientId === "managed-google-client",
				"Managed Google app missing",
			);
			const managedRow = await env.OAUTH_DB.prepare(
				"SELECT client_secret FROM oauth_apps WHERE id = 'google'",
			).first();
			assert(
				managedRow.client_secret === "",
				"Managed Google secret copied to D1",
			);
			const connection = await owner.beginConnection({
				appId: "google",
				browserBindingHash: "a".repeat(64),
			});
			assert(
				new URL(connection.authorizationUrl).searchParams.get("client_id") ===
					managed.clientId,
				"Managed Google authorization used the wrong client",
			);
			const appInput = {
				name: "Secret Store app",
				providerId: "google",
				clientId: "test-client",
				clientSecret: "sensitive-client-secret",
				scopes: [scope],
			};
			const app = await owner.createApp(appInput);
			const encrypted = await env.OAUTH_DB.prepare(
				"SELECT client_secret FROM oauth_apps WHERE id = ?",
			).bind(app.id).first();
			assert(
				encrypted.client_secret.startsWith("v1.primary."),
				"OAuth did not encrypt through Secrets Store keyring",
			);
			assert(
				!encrypted.client_secret.includes(appInput.clientSecret),
				"OAuth stored plaintext client secret",
			);
			await rejects(
				() => other.grantService("account", "integrations-google"),
				"Another owner could grant access",
			);
			await owner.grantService("account", "integrations-google");
			assert(
				(await integration.listConnections()).length === 1,
				"Granted connection missing",
			);
			using github = await env.GITHUB_ADMIN.admin("access:alice");
			assert(
				(await github.listConnections()).length === 0,
				"GitHub exposed a Google connection",
			);
			using google = await env.GOOGLE_ADMIN.admin("access:alice");
			assert(
				(await google.listConnections()).length === 1,
				"Google native binding failed",
			);
			assert(
				(await google.listEvents("account")).events.length === 0,
				"Expected empty migrated cache",
			);
			await google.syncGoogle("account");
			for (let attempt = 0; attempt < 30; attempt++) {
				if (
					(await google.listRecords("account", "events:primary").catch(() => ({
						records: [],
					}))).records.length
				) break;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			const contacts = await google.listRecords("account", "contacts");
			const calendars = await google.listRecords("account", "calendars");
			const events = await google.listRecords("account", "events:primary");
			assert(
				contacts.records[0]?.data.names[0].displayName === "Smoke Contact",
				"Contacts were not synced into DO SQLite",
			);
			assert(
				calendars.records[0]?.id === "primary",
				"Calendar list missing from DO SQLite",
			);
			assert(
				events.records[0]?.data.summary === "Smoke Event",
				"Events were not synced into DO SQLite",
			);
			const queryApi = async (assertion) => {
				const response = await env.API.fetch(
					new Request("http://localhost:4321/api/graphql", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...(assertion ? { "Cf-Access-Jwt-Assertion": assertion } : {}),
						},
						body: JSON.stringify({
							query:
								'query($id:ID!){me{id email googleAccount(connectionId:$id){id accountLabel contacts{records{id displayName emails phones}nextCursor} events(calendarId:"primary"){records{id summary start end}}}}}',
							variables: { id: "account" },
						}),
					}),
				);
				return { status: response.status, body: await response.json() };
			};
			const apiResult = await queryApi(env.API_ASSERTION);
			assert(
				apiResult.status === 200 && !apiResult.body.errors,
				`API query failed: ${JSON.stringify(apiResult.body)}`,
			);
			assert(
				apiResult.body.data.me.id === "access:alice",
				"API did not derive owner from verified JWT",
			);
			assert(
				apiResult.body.data.me.googleAccount.contacts.records[0]
					?.displayName === "Smoke Contact",
				"API did not read contact from account DO",
			);
			assert(
				apiResult.body.data.me.googleAccount.events.records[0]?.summary ===
					"Smoke Event",
				"API did not read event from account DO",
			);
			assert((await queryApi()).status === 401, "API allowed unsigned request");
			assert(
				(await queryApi(env.API_ASSERTION + "invalid")).status === 401,
				"API accepted invalid JWT signature",
			);
			const otherApi = await queryApi(env.OTHER_API_ASSERTION);
			assert(
				otherApi.body.data.me.googleAccount === null,
				"API leaked another owner's account",
			);
			using wrongOwner = await env.GOOGLE_ADMIN.admin("access:bob");
			await rejects(
				() => wrongOwner.listEvents("account"),
				"Another owner could read Google cache",
			);
			await env.OAUTH_DB.prepare(
				"UPDATE oauth_connections SET scopes = '[]' WHERE id = 'account'",
			).run();
			await rejects(
				() => google.listEvents("account"),
				"Removed calendar scope allowed cached read",
			);
			await owner.revokeService("account", "integrations-google");
			assert(
				(await integration.listConnections()).length === 0,
				"Retained capability bypassed revoked grant",
			);
			await rejects(
				() => google.listEvents("account"),
				"Revoked grant allowed Google cached read",
			);
			const coordinator = env.GOOGLE_ACCOUNTS.getByName("ungranted-account");
			await rejects(
				() => coordinator.start("ungranted-account", true),
				"Ungrantable account was started",
			);
			await rejects(
				() => coordinator.start("different-account"),
				"Durable Object identity could be changed",
			);
			await env.SECRET_STORE.put("google", env.ROTATED_GOOGLE_CREDENTIAL);
			await rejects(
				() => integration.listConnections(),
				"Retained RPC capability ignored credential rotation",
			);
			using rotated = await env.OAUTH.authorize(env.ROTATED_GOOGLE_CREDENTIAL);
			assert(
				(await rotated.listConnections()).length === 0,
				"Rotated credential could not authenticate",
			);
			assert(
				(await google.listConnections()).length === 0,
				"Google Worker did not reread rotated credential",
			);
			await owner.grantService("account", "integrations-google");
			await env.OAUTH_DB.prepare(
				"UPDATE oauth_connections SET scopes = ? WHERE id = 'account'",
			).bind(JSON.stringify(grantedScopes)).run();
			const control = async (name) => {
				const response = await fetch(`${env.PROVIDER_ORIGIN}/control/${name}`, {
					headers: { Authorization: "Bearer e2-smoke-google-token" },
				});
				return response.json();
			};
			await control("hold");
			await google.syncGoogle("account");
			let pending = false;
			for (let attempt = 0; attempt < 30; attempt++) {
				pending = (await control("pending")).pending;
				if (pending) break;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			assert(pending, "Deletion race did not reach in-flight provider fetch");
			await google.deleteAccount("account");
			await control("release");
			await new Promise((resolve) => setTimeout(resolve, 500));
			await google.deleteAccount("account");
			await rejects(
				() => google.listEvents("account"),
				"Deleted account allowed reads",
			);
			await rejects(
				() => env.GOOGLE_ACCOUNTS.getByName("account").start("account", true),
				"Deleted account restarted",
			);
			await owner.disconnect("account");
			await env.SECRET_STORE.delete("keyring");
			await rejects(
				() => owner.createApp(appInput),
				"Missing encryption secret was accepted",
			);
			return Response.json({
				ok: true,
				checks: [
					"OAuth D1 and account-local Drizzle migrations",
					"contacts and events sync into real DO SQLite",
					"GraphQL contacts/events through native API bindings",
					"API verifies JWT signature and owner isolation",
					"idempotent account deletion and restart fencing",
					"deletion while account sync awaits Google",
					"native Secrets Store encryption keyring",
					"managed Google app through native Secrets Store",
					"service credential rotation on retained RPC",
					"missing Secrets Store secret fails closed",
					"native OAuth service authentication",
					"owner grant checks",
					"grant/revoke on retained RPC capability",
					"Google service RPC",
					"GitHub service RPC",
					"cached data scope and owner checks",
					"GoogleAccount start and identity guard",
				],
			});
		} catch (error) {
			return Response.json({
				ok: false,
				error: String(error),
				stack: error.stack,
			}, { status: 500 });
		}
	},
};
