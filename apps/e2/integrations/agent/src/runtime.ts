import { type ChatInput, readChatInput, runChat } from "./chat.ts";
import type { VoiceDelegationRequest } from "./sideband.ts";
import { withinVoiceDeadline } from "./deadline.ts";
import {
	authenticate,
	type Identity,
	sameOriginPost,
} from "../../../website/src/lib/auth.ts";
import {
	fetchVoiceSession,
	type VoiceDependencies,
	type VoiceEnv,
} from "./session.ts";
import { createVoiceReservations, type VoiceStorage } from "./reservations.ts";
import { createApiDayReader, type DayApiBinding } from "./day-reader.ts";

export interface VoiceRuntimeEnv extends VoiceEnv {
	API: DayApiBinding;
}
const json = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const readSmallJSON = async (request: Request): Promise<unknown> => {
	// Bound the streaming request before decoding; Content-Length is not trusted.
	const reader = request.body?.getReader();
	if (!reader) return json({ error: "Invalid request" }, 400);
	let expired = false;
	const deadline = setTimeout(() => {
		expired = true;
		void reader.cancel("Body deadline").catch(() => {});
	}, 5000);
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 1024) {
				await reader.cancel();
				return json({ error: "Invalid request" }, 400);
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(deadline);
		reader.releaseLock();
	}
	if (expired) return json({ error: "Request body deadline" }, 408);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
};
/** Invoked only after JWT verification; every persisted ledger independently pins its owner. */
export const createOwnerVoiceRuntime = (
	storage: VoiceStorage,
	identity: Identity,
	env: VoiceRuntimeEnv,
	dependencies: Omit<VoiceDependencies, "reserve"> & {
		chat?: (
			request: VoiceDelegationRequest,
			input: ChatInput,
			original: Request,
		) => Promise<string>;
	} = {},
) => {
	const ledger = createVoiceReservations(storage, identity.ownerId);
	const verify = dependencies.authenticate ?? authenticate;
	const active = ledger.isSessionActive;
	return async (request: Request): Promise<Response> => {
		if (!sameOriginPost(request, env.WEBSITE_ORIGIN)) {
			return json({ error: "Forbidden" }, 403);
		}
		const current = await withinVoiceDeadline(() => verify(request, env));
		if (!current || current.ownerId !== identity.ownerId) {
			return json({ error: "Unauthorized" }, 401);
		}
		const path = new URL(request.url).pathname;
		if (path === "/api/voice/chat") {
			if (
				request.headers.get("Content-Type")?.split(";")[0].trim() !==
					"application/json"
			) return json({ error: "Use application/json" }, 415);
			let input: ChatInput;
			try {
				input = await readChatInput(request);
			} catch {
				return json({ error: "Invalid chat input" }, 400);
			}
			if (!dependencies.chat) return json({ error: "Chat unavailable" }, 503);
			const now = Date.now(), lease = crypto.randomUUID();
			const allowed = await storage.transaction(async (tx) => {
				const state = await tx.get<
					{ until: number; lease: string; window: number; count: number }
				>("chat-rate");
				if (state && state.until > now) return false;
				const fresh = !state || now - state.window >= 3600000;
				if (!fresh && state.count >= 30) return false;
				await tx.put("chat-rate", {
					until: now + 60000,
					lease,
					window: fresh ? now : state.window,
					count: fresh ? 1 : state.count + 1,
				});
				return true;
			});
			if (!allowed) {
				return json({
					error:
						"Chat is busy or its hourly limit was reached. No new request was started.",
				}, 429);
			}
			let completed = false;
			try {
				const result = json({
					text: await runChat(
						input,
						request.signal,
						(delegation, body) => dependencies.chat!(delegation, body, request),
					),
				});
				completed = true;
				return result;
			} catch {
				// The owner must see uncertainty, not an invitation to replay a possible write.
				return json({
					error:
						"Chat did not finish. Changes may have completed; check your data before sending the request again.",
				}, 503);
			} finally {
				await storage.transaction(async (tx) => {
					const state = await tx.get<
						{ until: number; lease: string; window: number; count: number }
					>("chat-rate");
					if (completed && state?.lease === lease) {
						await tx.put("chat-rate", { ...state, until: 0 });
					}
				});
			}
		}
		if (path === "/api/voice/status") {
			return json({ receipts: await ledger.receipts() });
		}
		if (path === "/api/voice/recovery") {
			if (
				!request.headers.get("Content-Type")?.startsWith("application/json")
			) {
				return json({ error: "Use application/json" }, 415);
			}
			let input: unknown;
			try {
				input = await readSmallJSON(request);
			} catch {
				return json({ error: "Invalid request" }, 400);
			}
			if (input instanceof Response) return input;
			if (
				!input || typeof input !== "object" || Array.isArray(input) ||
				Object.keys(input).some((key) =>
					!["requestID", "acknowledgeUnconfirmedSession"].includes(key)
				) ||
				!("requestID" in input) || typeof input.requestID !== "string" ||
				!("acknowledgeUnconfirmedSession" in input) ||
				input.acknowledgeUnconfirmedSession !== true
			) {
				return json({ error: "Explicit acknowledgement is required" }, 400);
			}
			const recovered = await ledger.recoverUnknown(
				current,
				input.requestID,
				true,
			);
			return recovered ? json({ receipts: await ledger.receipts() }) : json({
				error:
					"Only an expired unknown attempt without a session can be recovered",
			}, 409);
		}
		if (path === "/api/voice/sessions") {
			return fetchVoiceSession(request, env, {
				...dependencies,
				reserve: async (owner, requestID, device) => {
					// A validated explicit Start request grants voice access for this verified owner.
					await ledger.setEnabled(true);
					return ledger.reserve(owner, requestID, device);
				},
			});
		}
		const match = /^\/api\/voice\/sessions\/([^/]+)\/(end|day)$/.exec(path);
		if (!match) return json({ error: "Not found" }, 404);
		let sessionID: string;
		try {
			sessionID = decodeURIComponent(match[1]);
		} catch {
			return json({ error: "Invalid session" }, 400);
		}
		const receipt = (await ledger.receipts()).find((row) =>
			row.sessionID === sessionID
		);
		if (!receipt) return json({ error: "Not found" }, 404);
		if (match[2] === "end") {
			return closeOwnedVoiceSession(ledger, sessionID, env, dependencies.fetch);
		}
		if (!await active(sessionID)) {
			return json({ error: "Session is not active" }, 403);
		}
		if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
			return json({ error: "Use application/json" }, 415);
		}
		try {
			const input = await readSmallJSON(request);
			if (input instanceof Response) return input;
			if (
				!input || typeof input !== "object" || Array.isArray(input) ||
				Object.keys(input).some((key) => !["date", "timeZone"].includes(key)) ||
				!("date" in input) || typeof input.date !== "string" ||
				!("timeZone" in input) || typeof input.timeZone !== "string"
			) return json({ error: "Invalid request" }, 400);
			const readDay = await createApiDayReader(request, env, env.API, {
				authenticate: verify,
			});
			const day = await readDay(identity.ownerId, {
				date: input.date,
				timeZone: input.timeZone,
			}, request.signal);
			if (!await active(sessionID)) {
				return json({ error: "Session is not active" }, 403);
			}
			return json(day);
		} catch {
			return json({ error: "Unable to read your day" }, 502);
		}
	};
};

/** Trusted lifecycle helper: owner ledger was selected from verified identity.
 * Cleanup remains possible after the original browser JWT expires. */
export const closeOwnedVoiceSession = async (
	ledger: ReturnType<typeof createVoiceReservations>,
	sessionID: string,
	env: VoiceEnv,
	upstreamFetch: typeof fetch = fetch,
): Promise<Response> => {
	const receipt = (await ledger.receipts()).find((row) =>
		row.sessionID === sessionID
	);
	if (!receipt) return json({ error: "Not found" }, 404);

	if (receipt.state === "closed") return json({ state: "closed" });
	const key = await withinVoiceDeadline(() => env.OPENAI_API_KEY.get());
	if (!key) return json({ error: "Voice is not configured" }, 503);
	try {
		const response = await upstreamFetch(
			`https://api.openai.com/v1/live/sessions/${
				encodeURIComponent(sessionID)
			}/hangup`,
			{
				method: "POST",
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				headers: { Authorization: `Bearer ${key}` },
			},
		);
		await response.body?.cancel();
		if (!response.ok) throw new Error("Hangup not confirmed");
		await ledger.reconcile(receipt.requestID, {
			state: "closed",
			sessionID,
		});
		return json({ state: "closed" });
	} catch {
		return json({
			error: "Session end is not confirmed. Try ending again.",
		}, 502);
	}
};
