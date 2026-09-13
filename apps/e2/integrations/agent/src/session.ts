import { withinVoiceDeadline } from "./deadline.ts";
import {
	type AuthConfig,
	authenticate,
	type Identity,
	sameOriginPost,
} from "../../../website/src/lib/auth.ts";

export type VoiceDevice = "iphone" | "carplay" | "mac";
export type SessionOutcome = { state: "created"; sessionID: string } | {
	state: "unknown";
};
/** Production implementation must atomically reserve quota/idempotency for this
 * authenticated owner, then durably retain created/unknown outcomes. */
export interface SessionPermit {
	isCurrent(): Promise<boolean>;
	record(outcome: SessionOutcome): Promise<void>;
}
export interface VoiceDependencies {
	reserve(
		identity: Identity,
		requestID: string,
		device: VoiceDevice,
	): Promise<SessionPermit | null>;
	attach?(
		identity: Identity,
		requestID: string,
		sessionID: string,
		request: Request,
		context: { timeZone: string },
	): Promise<void>;
	fetch?: typeof fetch;
	authenticate?: typeof authenticate;
}
export interface VoiceEnv extends AuthConfig {
	OPENAI_API_KEY: { get(): Promise<string | null> };
}
const json = (body: unknown, status: number) =>
	Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const readJSON = async (
	body: ReadableStream<Uint8Array> | null,
): Promise<unknown> => {
	if (!body) throw new Error("Missing body");
	const reader = body.getReader();
	let expired = false;
	const deadline = setTimeout(() => {
		expired = true;
		void reader.cancel("Body deadline").catch(() => {});
	}, 5000);
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 65_536) {
				await reader.cancel();
				throw new Error("Body too large");
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(deadline);
		reader.releaseLock();
	}
	if (expired) throw new Error("Body deadline");
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
};
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};

/** Route only through the existing trusted Access gateway.
 * The request cannot select an owner, model, tool, prompt, endpoint or credential. */
export const fetchVoiceSession = async (
	request: Request,
	env: VoiceEnv,
	dependencies: VoiceDependencies,
): Promise<Response> => {
	if (new URL(request.url).pathname !== "/api/voice/sessions") {
		return json({ error: "Not found" }, 404);
	}
	if (request.method !== "POST") {
		return json({ error: "Method not allowed" }, 405);
	}
	if (!sameOriginPost(request, env.WEBSITE_ORIGIN)) {
		return json({ error: "Forbidden" }, 403);
	}
	const identity = await withinVoiceDeadline(() =>
		(dependencies.authenticate ?? authenticate)(request, env)
	);
	if (!identity) return json({ error: "Unauthorized" }, 401);
	if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
		return json({ error: "Use application/json" }, 415);
	}
	let input: Record<string, unknown>;
	try {
		input = object(await readJSON(request.body));
	} catch {
		return json({ error: "Invalid request" }, 400);
	}
	const { sdp, device, requestID, timeZone = "UTC" } = input;
	try {
		if (
			typeof timeZone !== "string" || timeZone.length > 100 ||
			/^[+-]/.test(timeZone)
		) throw new Error();
		new Intl.DateTimeFormat("en", { timeZone });
	} catch {
		return json({ error: "Invalid time zone" }, 400);
	}
	if (
		Object.keys(input).some((key) =>
			!["sdp", "device", "requestID", "timeZone"].includes(key)
		) ||
		typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 60_000 ||
		!["iphone", "carplay", "mac"].includes(String(device)) ||
		typeof requestID !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestID)
	) return json({ error: "Invalid request" }, 400);
	const key = await withinVoiceDeadline(() => env.OPENAI_API_KEY.get());
	if (!key) return json({ error: "Voice is not configured" }, 503);
	const permit = await dependencies.reserve(
		identity,
		requestID,
		device as VoiceDevice,
	);
	if (!permit || !await permit.isCurrent()) {
		return json({ error: "Voice session is not permitted" }, 403);
	}
	let createdSessionID: string | undefined;
	let receiptRecorded = false;
	try {
		const upstream = await (dependencies.fetch ?? fetch)(
			"https://api.openai.com/v1/live/sessions",
			{
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					session: {
						model: "gpt-live-1",
						store: false,
						delegation: { type: "client" },
						instructions:
							"Be concise. Delegate requests about the user's data to the application. Never claim that an action completed without an application result.",
					},
					transport: { type: "webrtc", sdp },
				}),
			},
		);
		if (!upstream.ok) {
			await upstream.body?.cancel();
			throw new Error("Provider failed");
		}
		const result = object(await readJSON(upstream.body));
		const session = object(result.session),
			transport = object(result.transport);
		if (
			typeof session.id !== "string" || !session.id ||
			session.id.length > 256
		) throw new Error("Invalid response");
		createdSessionID = session.id;
		if (typeof transport.sdp !== "string" || !transport.sdp.startsWith("v=0")) {
			throw new Error("Invalid response");
		}
		await permit.record({ state: "created", sessionID: createdSessionID });
		receiptRecorded = true;
		await dependencies.attach?.(
			identity,
			requestID,
			createdSessionID,
			request,
			{ timeZone: timeZone as string },
		);
		if (!await permit.isCurrent()) {
			return json({ error: "Voice session permission changed" }, 403);
		}
		return json({
			session: { id: session.id },
			transport: { type: "webrtc", sdp: transport.sdp },
		}, 201);
	} catch {
		// Creation may have reached the provider. Never automatically retry or
		// release the reservation as if nothing happened.
		if (!receiptRecorded) {
			await permit.record(
				createdSessionID
					? { state: "created", sessionID: createdSessionID }
					: { state: "unknown" },
			).catch(() => {});
		}
		return json({
			error:
				"Voice session could not be confirmed. Do not automatically retry.",
		}, 502);
	}
};
