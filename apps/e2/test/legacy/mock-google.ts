import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

type Grant = {
	clientId: string;
	redirectUri: string;
	challenge: string;
	nonce: string;
	scope: string;
	account: string;
};
const escape = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			]!,
	);

export const startMockGoogle = async (port = 8790) => {
	const keys = await generateKeyPair("RS256", { extractable: true });
	const jwk = {
		...await exportJWK(keys.publicKey),
		kid: "local",
		alg: "RS256",
		use: "sig",
	};
	const codes = new Map<string, Grant>();
	const refreshTokens = new Map<string, Grant>();
	const accessTokens = new Map<string, Grant>();
	let revision = 1;
	let refreshCount = 0;
	let rejectRefresh = false;
	let failSecondPage = false;
	let shortTokens = false;
	let omitRotatedRefresh = false;
	let refreshDelayMs = 0;
	let origin = "";
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port, onListen: () => {} },
		async (request) => {
			const url = new URL(request.url);
			const json = (value: unknown, status = 200) =>
				Response.json(value, { status });
			if (url.pathname === "/health") {
				return json({
					service: "local-google",
					status: "ok",
				});
			}
			if (url.pathname === "/jwks") return json({ keys: [jwk] });
			if (url.pathname === "/__test/status") {
				return json({
					refreshCount,
					revision,
				});
			}
			if (url.pathname === "/__test/control" && request.method === "POST") {
				const body = await request.json() as {
					revision?: number;
					rejectRefresh?: boolean;
					failSecondPage?: boolean;
					shortTokens?: boolean;
					omitRotatedRefresh?: boolean;
					refreshDelayMs?: number;
				};
				revision = body.revision ?? revision;
				rejectRefresh = body.rejectRefresh ?? rejectRefresh;
				failSecondPage = body.failSecondPage ?? failSecondPage;
				shortTokens = body.shortTokens ?? shortTokens;
				omitRotatedRefresh = body.omitRotatedRefresh ?? omitRotatedRefresh;
				refreshDelayMs = Math.min(body.refreshDelayMs ?? refreshDelayMs, 1000);
				return json({ ok: true });
			}
			if (url.pathname === "/authorize") {
				const redirect = url.searchParams.get("redirect_uri");
				if (
					!redirect ||
					!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/oauth\/callback\/google$/
						.test(redirect) ||
					url.searchParams.get("response_type") !== "code" ||
					url.searchParams.get("code_challenge_method") !== "S256"
				) return json({ error: "invalid_request" }, 400);
				if (!url.searchParams.has("approve")) {
					return new Response(
						`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local Google test provider</title></head><body style="font:17px system-ui;max-width:640px;margin:10vh auto;padding:24px"><h1>Local Google test provider</h1><p>This uses a test account and sample calendar events. No request goes to Google.</p><p>Permissions: ${
							escape(url.searchParams.get("scope") || "")
						}</p><form method="get">${
							[...url.searchParams].map(([key, value]) =>
								`<input type="hidden" name="${escape(key)}" value="${
									escape(value)
								}">`
							).join("")
						}<button name="approve" value="yes" style="font:inherit;padding:12px">Connect test account</button> <button name="approve" value="no" style="font:inherit;padding:12px">Cancel</button></form></body></html>`,
						{
							headers: {
								"Content-Type": "text/html; charset=utf-8",
								"Cache-Control": "no-store",
							},
						},
					);
				}
				const callback = new URL(redirect);
				callback.searchParams.set("state", url.searchParams.get("state") || "");
				if (url.searchParams.get("approve") !== "yes") {
					callback.searchParams
						.set("error", "access_denied");
				} else {
					const code = crypto.randomUUID();
					codes.set(code, {
						clientId: url.searchParams.get("client_id")!,
						redirectUri: redirect,
						challenge: url.searchParams.get("code_challenge")!,
						nonce: url.searchParams.get("nonce")!,
						scope: url.searchParams.get("scope")!,
						account: "local-google-user",
					});
					callback.searchParams.set("code", code);
				}
				return Response.redirect(callback, 303);
			}
			if (url.pathname === "/token" && request.method === "POST") {
				const body = new URLSearchParams(await request.text());
				if (!body.get("client_secret")) {
					return json({
						error: "invalid_client",
					}, 401);
				}
				const refreshing = body.get("grant_type") === "refresh_token";
				let grant: Grant | undefined;
				if (refreshing) {
					refreshCount++;
					if (refreshDelayMs) await delay(refreshDelayMs);
					grant = refreshTokens.get(body.get("refresh_token") || "");
					if (rejectRefresh) return json({ error: "invalid_grant" }, 400);
					if (grant && !omitRotatedRefresh) {
						refreshTokens.delete(
							body.get("refresh_token")!,
						);
					}
				} else if (body.get("grant_type") === "authorization_code") {
					const code = body.get("code") || "";
					grant = codes.get(code);
					codes.delete(code);
					const challenge = createHash("sha256").update(
						body.get("code_verifier") || "",
					).digest("base64url");
					if (
						!grant || grant.challenge !== challenge ||
						grant.redirectUri !== body.get("redirect_uri")
					) return json({ error: "invalid_grant" }, 400);
				}
				if (!grant || grant.clientId !== body.get("client_id")) {
					return json({
						error: "invalid_grant",
					}, 400);
				}
				const access = crypto.randomUUID();
				const refresh = crypto.randomUUID();
				accessTokens.set(access, grant);
				if (!refreshing || !omitRotatedRefresh) {
					refreshTokens.set(
						refresh,
						grant,
					);
				}
				const idToken = await new SignJWT({
					email: "alex@example.test",
					email_verified: true,
					nonce: grant.nonce,
				})
					.setProtectedHeader({ alg: "RS256", kid: "local" }).setIssuer(origin)
					.setAudience(grant.clientId).setSubject(grant.account).setIssuedAt()
					.setExpirationTime("1h").sign(keys.privateKey);
				return json({
					access_token: access,
					...(!refreshing || !omitRotatedRefresh
						? { refresh_token: refresh }
						: {}),
					token_type: "Bearer",
					expires_in: shortTokens ? 30 : 3600,
					scope: grant.scope,
					...(!refreshing ? { id_token: idToken } : {}),
				});
			}
			const grant = accessTokens.get(
				request.headers.get("Authorization")?.replace(/^Bearer /, "") || "",
			);
			if (!grant) return json({ error: "unauthorized" }, 401);
			if (url.pathname === "/userinfo") {
				return json({
					sub: grant.account,
					email: "alex@example.test",
					email_verified: true,
				});
			}
			if (url.pathname === "/calendar/v3/users/me/calendarList") {
				return json({
					items: [{ id: "primary", summary: "Personal", accessRole: "owner" }, {
						id: "work",
						summary: "Work",
						accessRole: "reader",
					}],
					nextSyncToken: `list-${revision}`,
				});
			}
			if (url.pathname === "/calendar/v3/calendars/work/events") {
				return json({
					items: [{
						id: "planning",
						summary: "Work planning",
						start: { date: "2026-09-15" },
					}],
					nextSyncToken: `work-${revision}`,
				});
			}
			if (url.pathname === "/v1/people/me/connections") {
				if (url.searchParams.get("syncToken") && revision >= 3) {
					return json({
						error: { details: [{ reason: "EXPIRED_SYNC_TOKEN" }] },
					}, 400);
				}
				return json({
					connections: [{
						resourceName: "people/alex",
						names: [{ displayName: revision >= 2 ? "Alex Updated" : "Alex" }],
						emailAddresses: [{ value: "alex@example.test" }],
					}, {
						resourceName: "people/deleted",
						metadata: { deleted: revision >= 2 },
						names: [{ displayName: "Former contact" }],
					}],
					nextSyncToken: `people-${revision}`,
				});
			}
			if (url.pathname === "/gmail/v1/users/me/profile") {
				return json({
					emailAddress: "alex@example.test",
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages/message-1") {
				return json({
					payload: {
						headers: [{ name: "From", value: "Sam <sam@example.test>" }],
					},
				});
			}
			if (url.pathname === "/gmail/v1/users/me/watch") {
				return json({
					historyId: "12345678901234567890",
					expiration: String(Date.now() + 604800000),
				});
			}
			if (url.pathname === "/gmail/v1/users/me/messages") {
				return json({
					messages: [{ id: "message-1", threadId: "thread-1" }],
					resultSizeEstimate: 1,
				});
			}
			if (url.pathname === "/calendar/v3/calendars/primary/events") {
				const cursor = url.searchParams.get("syncToken");
				if (
					cursor && cursor !== `sync-${revision}` && revision >= 3
				) return json({ error: "expired" }, 410);
				if (cursor === `sync-${revision}`) {
					return json({
						items: [],
						nextSyncToken: cursor,
					});
				}
				if (failSecondPage && url.searchParams.has("pageToken")) {
					return json({
						error: "temporary",
					}, 503);
				}
				const first = {
					id: "planning",
					summary: revision >= 2
						? "Weekly planning (updated)"
						: "Weekly planning",
					status: "confirmed",
					start: { dateTime: "2026-09-14T09:00:00Z" },
					end: { dateTime: "2026-09-14T09:30:00Z" },
				};
				const second = revision >= 2 ? { id: "focus", status: "cancelled" } : {
					id: "focus",
					summary: "Focus time",
					status: "confirmed",
					start: { dateTime: "2026-09-14T10:00:00Z" },
					end: { dateTime: "2026-09-14T11:00:00Z" },
				};
				return url.searchParams.has("pageToken")
					? json({ items: [second], nextSyncToken: `sync-${revision}` })
					: json({ items: [first], nextPageToken: "page-2" });
			}
			return new Response("Not found", { status: 404 });
		},
	);
	origin = `http://127.0.0.1:${server.addr.port}`;
	return { server, origin };
};

if (import.meta.main) {
	const { origin } = await startMockGoogle();
	console.log(`Local test provider: ${origin}`);
}
