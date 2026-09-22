import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Connection, OAuthIntegrationApi } from "@e2/oauth-client";
import type { AccountEnv, CalendarEnv } from "./env.ts";
import { authorized, endpoint, googleRequest, scopes } from "./google.ts";

const keys = createRemoteJWKSet(
	new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export const mailPeople = async (
	env: CalendarEnv,
	oauth: OAuthIntegrationApi,
	connection: Connection,
	from: string,
	to: string,
) => {
	const start = Date.parse(from), end = Date.parse(to);
	if (
		!Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
		end - start > 172800000
	) throw new Error("Invalid email window");
	const found = await searchMail(
		env,
		oauth,
		connection,
		`after:${Math.floor(start / 1000)} before:${Math.floor(end / 1000)}`,
	);
	const people = new Map<string, { email: string; name: string }>();
	for (const message of found.messages.slice(0, 5)) {
		const url = endpoint(
			env,
			`/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}`,
		);
		url.searchParams.set("format", "metadata");
		for (const header of ["From", "To", "Cc"]) {
			url.searchParams.append("metadataHeaders", header);
		}
		const response = await googleRequest(oauth, connection, scopes.gmail, url);
		if (!response.ok) throw new Error("Mail participants unavailable");
		const body = await response.json() as {
			payload?: { headers?: { name: string; value: string }[] };
		};
		for (const header of body.payload?.headers ?? []) {
			if (["from", "to", "cc"].includes(header.name.toLowerCase())) {
				for (
					const match of header.value.matchAll(
						/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
					)
				) {
					const email = match[0].toLowerCase();
					if (email !== connection.accountLabel.toLowerCase()) {
						people.set(email, { email, name: email });
					}
				}
			}
		}
	}
	await authorized(oauth, connection, scopes.gmail);
	return {
		people: [...people.values()],
		partial: found.messages.length > 5 || Boolean(found.nextPageToken),
	};
};
export const searchMail = async (
	env: CalendarEnv,
	oauth: OAuthIntegrationApi,
	connection: Connection,
	query: string,
	pageToken?: string,
) => {
	if (
		typeof query !== "string" || query.length > 2000 ||
		(pageToken !== undefined &&
			(typeof pageToken !== "string" || pageToken.length > 4096))
	) throw new Error("Invalid Gmail search");
	const url = endpoint(env, "/gmail/v1/users/me/messages");
	url.searchParams.set("q", query);
	url.searchParams.set("maxResults", "50");
	if (pageToken) url.searchParams.set("pageToken", pageToken);
	const response = await googleRequest(oauth, connection, scopes.gmail, url);
	if (!response.ok) throw new Error("Gmail search unavailable");
	const body = await response.json() as {
		messages?: { id: string; threadId: string }[];
		nextPageToken?: string;
		resultSizeEstimate?: number;
	};
	await authorized(oauth, connection, scopes.gmail);
	return {
		messages: body.messages ?? [],
		nextPageToken: body.nextPageToken,
		resultSizeEstimate: body.resultSizeEstimate ?? 0,
	};
};

export const watchMail = async (
	env: AccountEnv,
	oauth: OAuthIntegrationApi,
	connection: Connection,
) => {
	if (
		!env.GMAIL_PUBSUB_TOPIC ||
		!/^projects\/[^/]+\/topics\/[^/]+$/.test(env.GMAIL_PUBSUB_TOPIC)
	) throw new Error("Configure a Gmail Pub/Sub topic first");
	const profile = await googleRequest(
		oauth,
		connection,
		scopes.gmail,
		endpoint(env, "/gmail/v1/users/me/profile"),
	);
	if (!profile.ok) throw new Error("Gmail profile unavailable");
	const { emailAddress } = await profile.json() as { emailAddress: string };
	const response = await googleRequest(
		oauth,
		connection,
		scopes.gmail,
		endpoint(env, "/gmail/v1/users/me/watch"),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ topicName: env.GMAIL_PUBSUB_TOPIC }),
		},
	);
	if (!response.ok) {
		throw new Error("Gmail watch unavailable; check Pub/Sub configuration");
	}
	const body = await response.json() as {
		historyId: string;
		expiration: string;
	};
	if (
		typeof emailAddress !== "string" || !/^\d+$/.test(body.historyId) ||
		!Number.isFinite(Number(body.expiration))
	) throw new Error("Invalid Gmail watch response");
	await authorized(oauth, connection, scopes.gmail);
	await env.DB.prepare(
		"INSERT INTO gmail_watches(connection_id, email, expiration, history_id, renewed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET email = excluded.email, expiration = excluded.expiration, renewed_at = excluded.renewed_at",
	)
		.bind(
			connection.id,
			emailAddress.toLowerCase(),
			Number(body.expiration),
			body.historyId,
			Date.now(),
		).run();
	return { expiration: Number(body.expiration) };
};

/** Authenticated Pub/Sub invalidation signal only. No email content is retained. */
export const receiveMailNotification = async (
	request: Request,
	env: CalendarEnv,
	oauth: OAuthIntegrationApi,
) => {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	if (
		!env.GMAIL_PUSH_AUDIENCE || !env.GMAIL_PUSH_SERVICE_ACCOUNT ||
		!env.GMAIL_PUSH_SUBSCRIPTION
	) return new Response("Push not configured", { status: 503 });
	try {
		const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)
			?.[1];
		if (!token) throw new Error("Missing token");
		const { payload } = await jwtVerify(token, keys, {
			issuer: ["https://accounts.google.com", "accounts.google.com"],
			audience: env.GMAIL_PUSH_AUDIENCE,
			algorithms: ["RS256"],
			requiredClaims: ["exp", "iat", "sub"],
		});
		if (
			payload.email !== env.GMAIL_PUSH_SERVICE_ACCOUNT ||
			payload.email_verified !== true
		) throw new Error("Invalid identity");
	} catch {
		return new Response("Unauthorized", { status: 401 });
	}
	const reader = request.body?.getReader();
	if (!reader) return new Response("Invalid payload", { status: 400 });
	let text = "", size = 0;
	const decoder = new TextDecoder();
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > 16_384) {
			await reader.cancel();
			return new Response("Too large", { status: 413 });
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	let email: string, history: string;
	try {
		const body = JSON.parse(text + decoder.decode());
		if (body.subscription !== env.GMAIL_PUSH_SUBSCRIPTION) {
			throw new Error("Wrong subscription");
		}
		const data = JSON.parse(
			atob(body.message.data.replace(/-/g, "+").replace(/_/g, "/")),
		);
		if (
			typeof data.emailAddress !== "string" ||
			typeof data.historyId !== "string" || !/^\d{1,40}$/.test(data.historyId)
		) throw new Error("Invalid notification");
		email = data.emailAddress.toLowerCase();
		history = data.historyId;
	} catch {
		return new Response("Invalid payload", { status: 400 });
	}
	for (const connection of await oauth.listConnections()) {
		if (
			connection.providerId !== "google" || connection.status !== "connected" ||
			!connection.scopes.includes(scopes.gmail)
		) continue;
		await env.GOOGLE_ACCOUNTS.getByName(connection.id).notifyMail(
			connection.id,
			email,
			history,
		);
	}
	return new Response(null, { status: 204 });
};
