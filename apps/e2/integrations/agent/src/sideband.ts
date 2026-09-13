import { VoiceExecutionError } from "./execution-limits.ts";
import { type ChatInput, parseChatInput } from "./chat.ts";
/** GPT-Live server-side control. Media remains on the primary WebRTC connection. */
export interface LiveControlSocket {
	accept(): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: string,
		listener: (event: { data?: unknown }) => void,
	): void;
	removeEventListener(
		type: string,
		listener: (event: { data?: unknown }) => void,
	): void;
}
export interface VoiceTranscriptFragment {
	speaker: "user" | "assistant";
	text: string;
	startMs: number;
	endMs: number;
}
export interface VoiceDelegationRequest {
	delegationID: string;
	offsetMs: number;
	transcript: readonly VoiceTranscriptFragment[];
	signal: AbortSignal;
}
export interface SidebandResult {
	finalized: boolean;
	reason: string;
	seconds?: number;
}
const providerCodes = [
	"unknown_parameter",
	"missing_required_parameter",
	"invalid_parameter",
	"invalid_value",
	"invalid_type",
	"invalid_event",
	"invalid_event_type",
	"invalid_request",
	"invalid_request_error",
	"invalid_delegation",
	"invalid_delegation_id",
	"delegation_not_found",
	"unknown_delegation",
	"not_found",
	"permission_denied",
	"forbidden",
	"rate_limit_exceeded",
	"server_error",
	"internal_error",
	"context_length_exceeded",
	"string_above_max_length",
	"invalid_client_event",
	"unsupported_event",
	"unsupported_parameter",
] as const;
const providerTypes = [
	"invalid_request_error",
	"server_error",
	"authentication_error",
	"permission_error",
	"rate_limit_error",
] as const;
const providerParams = [
	"type",
	"event_id",
	"delegation_id",
	"content",
	"session.delegation",
	"session.delegation.type",
] as const;
const allowed = <T extends string>(
	value: unknown,
	values: readonly T[],
): T | "other" =>
	typeof value === "string" && values.includes(value as T)
		? value as T
		: "other";
export interface VoiceControlDiagnostic {
	stage:
		| "socket_accepted"
		| "greeting_sent"
		| "greeting_accepted"
		| "greeting_rejected"
		| "message_ignored"
		| "transcript_accepted"
		| "delegation_accepted"
		| "delegation_ignored"
		| "execution_started"
		| "execution_completed"
		| "execution_failed"
		| "commentary_sent"
		| "commentary_accepted"
		| "commentary_rejected"
		| "provider_error"
		| "control_finished";
	code?:
		| "non_text"
		| "malformed_json"
		| "provider_error"
		| "invalid_transcript"
		| "invalid_delegation"
		| "duplicate"
		| "empty_context"
		| "with_context"
		| "executor_failed"
		| "executor_deadline"
		| "executor_cancelled"
		| "invalid_result"
		| "result_too_large"
		| "deadline_or_cancelled"
		| "operation_failed"
		| "success"
		| "fallback";
	elapsedMs?: number;
	providerCode?: typeof providerCodes[number] | "other";
	providerType?: typeof providerTypes[number] | "other";
	providerParam?: typeof providerParams[number] | "other";
	correlated?: boolean;
}
export interface SidebandOptions {
	diagnostic?(event: VoiceControlDiagnostic): void;
	history?: ChatInput["history"];
	sessionID: string;
	apiKey: string;
	authorize(): Promise<boolean>;
	/** Return short sourced facts. This callback owns model/tool permissions. */
	execute(request: VoiceDelegationRequest): Promise<string>;
	/** Only called for a provider session.closed event, never socket disconnect. */
	onClosed(result: SidebandResult): Promise<void>;
	connect?: (
		sessionID: string,
		key: string,
		signal: AbortSignal,
	) => Promise<LiveControlSocket>;
	limits?: {
		attachMs?: number;
		workMs?: number;
		closeMs?: number;
		lifetimeMs?: number;
	};
}
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
const bounded = async <T>(
	action: (signal: AbortSignal) => Promise<T>,
	milliseconds: number,
	parent?: AbortSignal,
	abortAfterSuccess = true,
): Promise<T> => {
	const abort = new AbortController();
	const cancel = () => abort.abort();
	parent?.addEventListener("abort", cancel, { once: true });
	if (parent?.aborted) abort.abort();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let completed = false;
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => {
				if (abort.signal.aborted) throw new Error("Canceled");
				return action(abort.signal);
			}),
			new Promise<never>((_, reject) => {
				abort.signal.addEventListener(
					"abort",
					() => reject(new Error("Canceled")),
					{ once: true },
				);
				if (abort.signal.aborted) reject(new Error("Canceled"));
				timer = setTimeout(() => {
					abort.abort();
					reject(new Error("Deadline"));
				}, milliseconds);
			}),
		]);
		completed = true;
		return result;
	} finally {
		clearTimeout(timer);
		parent?.removeEventListener("abort", cancel);
		if (!completed || abortAfterSuccess) abort.abort();
	}
};
/** Worker fetch supports the authenticated Upgrade; no key is returned to clients. */
export const connectLiveSideband = async (
	sessionID: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<LiveControlSocket> => {
	const response = await fetch(
		`https://api.openai.com/v1/live/sessions/${
			encodeURIComponent(sessionID)
		}/attach`,
		{
			headers: { Authorization: `Bearer ${apiKey}`, Upgrade: "websocket" },
			redirect: "manual",
			signal,
		},
	);
	const socket =
		(response as Response & { webSocket?: LiveControlSocket }).webSocket;
	if (response.status !== 101 || !socket) {
		await response.body?.cancel();
		throw new Error("Voice control connection unavailable");
	}
	return socket;
};

export const attachLiveSideband = async (options: SidebandOptions) => {
	const diagnostic = (event: VoiceControlDiagnostic) => {
		try {
			options.diagnostic?.(event);
		} catch { /* Diagnostics never alter control flow. */ }
	};
	const history =
		parseChatInput({ message: "resume", history: options.history ?? [] })
			.history;
	if (history.reduce((size, row) => size + row.content.length, 0) > 12000) {
		throw new Error("History too large");
	}
	if (!options.sessionID || options.sessionID.length > 256 || !options.apiKey) {
		throw new Error("Invalid voice control configuration");
	}
	const duration = (value: number | undefined, fallback: number) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? Math.min(value, fallback)
			: fallback;
	const workMs = duration(options.limits?.workMs, 12_000);
	const closeMs = duration(options.limits?.closeMs, 5_000);
	if (!await bounded(() => options.authorize(), 2_000)) {
		throw new Error("Voice permission unavailable");
	}
	const socket = await bounded(
		async (signal) => {
			const value = await (options.connect ?? connectLiveSideband)(
				options.sessionID,
				options.apiKey,
				signal,
			);
			if (signal.aborted) {
				value.close();
				throw new Error("Voice control connection expired");
			}
			return value;
		},
		duration(options.limits?.attachMs, 5_000),
		undefined,
		// A successful Upgrade transfers ownership to socket.close(). Aborting the
		// fetch signal here tears down the live socket and triggers call cleanup.
		false,
	);
	let resolveFinished!: (result: SidebandResult) => void;
	const finished = new Promise<SidebandResult>((resolve) => {
		resolveFinished = resolve;
	});
	const cancellation = new AbortController();
	let terminal = false;
	let closing = false;
	let pending = 0;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let queue: Promise<void> = Promise.resolve();
	const transcript: VoiceTranscriptFragment[] = history.map((row, index) => ({
		speaker: row.role,
		text: row.content,
		startMs: index - history.length,
		endMs: index - history.length,
	}));
	const delegations = new Set<string>();
	const seen = new Set<string>();
	const sentCommentary = new Map<string, number>();
	let pendingGreeting: { id: string; started: number } | undefined;
	const cleanup = () => {
		clearTimeout(closeTimer);
		clearTimeout(lifeTimer);
		cancellation.abort();
		for (const [type, listener] of listeners) {
			socket.removeEventListener(type, listener);
		}
		try {
			socket.close(1000, "Voice control ended");
		} catch { /* Already closed. */ }
		transcript.length = 0;
		seen.clear();
		sentCommentary.clear();
		pendingGreeting = undefined;
		delegations.clear();
	};
	const finish = (result: SidebandResult) => {
		if (terminal) return;
		terminal = true;
		diagnostic({ stage: "control_finished" });
		cleanup();
		if (!result.finalized) {
			resolveFinished(result);
			return;
		}
		// Receipt persistence is bounded too; a failed receipt must remain unreconciled.
		void bounded(() => options.onClosed(result), 2_000).then(
			() => resolveFinished(result),
			() => resolveFinished({ ...result, reason: "close_receipt_not_saved" }),
		);
	};
	const close = () => {
		if (terminal || closing) return finished;
		closing = true;
		cancellation.abort();
		closeTimer = setTimeout(
			() => finish({ finalized: false, reason: "close_timeout" }),
			closeMs,
		);
		try {
			socket.send(JSON.stringify({ type: "session.close" }));
		} catch {
			finish({ finalized: false, reason: "connection_lost" });
		}
		return finished;
	};
	const append = (delegationID: string, content: string, fallback = false) => {
		if (terminal || closing) return;
		const eventID = crypto.randomUUID();
		sentCommentary.set(eventID, Date.now());
		if (sentCommentary.size > 64) {
			sentCommentary.delete(sentCommentary.keys().next().value!);
		}
		socket.send(JSON.stringify({
			type: "session.commentary.append",
			event_id: eventID,
			delegation_id: delegationID,
			content,
		}));
		diagnostic({
			stage: "commentary_sent",
			code: fallback ? "fallback" : "success",
		});
	};
	const message = (event: { data?: unknown }) => {
		if (terminal) return;
		if (typeof event.data !== "string") {
			diagnostic({ stage: "message_ignored", code: "non_text" });
			return;
		}
		if (event.data.length > 131_072) {
			void close();
			return;
		}
		let value: Record<string, unknown>;
		try {
			value = record(JSON.parse(event.data));
		} catch {
			diagnostic({ stage: "message_ignored", code: "malformed_json" });
			void close();
			return;
		}
		if (
			value.type === "session.commentary.appended" ||
			value.type === "session.instructions.appended" || value.type === "error"
		) {
			const error = record(value.error);
			const clientID = value.type === "error"
				? error.client_event_id ?? value.client_event_id
				: value.client_event_id;
			if (
				pendingGreeting && clientID === pendingGreeting.id &&
				value.type !== "session.commentary.appended"
			) {
				diagnostic({
					stage: value.type === "error"
						? "greeting_rejected"
						: "greeting_accepted",
					correlated: true,
					elapsedMs: Date.now() - pendingGreeting.started,
					...(value.type === "error"
						? {
							code: "provider_error",
							providerCode: allowed(error.code, providerCodes),
							providerType: allowed(error.type, providerTypes),
							providerParam: allowed(error.param, providerParams),
						}
						: {}),
				});
				pendingGreeting = undefined;
				return;
			}
			if (value.type === "session.instructions.appended") return;
			const started = typeof clientID === "string"
				? sentCommentary.get(clientID)
				: undefined;
			if (typeof clientID === "string") sentCommentary.delete(clientID);
			diagnostic({
				stage: value.type === "session.commentary.appended"
					? "commentary_accepted"
					: started === undefined
					? "provider_error"
					: "commentary_rejected",
				correlated: started !== undefined,
				...(started === undefined ? {} : { elapsedMs: Date.now() - started }),
				...(value.type === "error"
					? {
						code: "provider_error",
						providerCode: allowed(error.code, providerCodes),
						providerType: allowed(error.type, providerTypes),
						providerParam: allowed(error.param, providerParams),
					}
					: {}),
			});
			return;
		}
		if (value.type === "session.closed") {
			const session = record(value.session);
			if (session.id !== options.sessionID) {
				finish({ finalized: false, reason: "session_mismatch" });
				return;
			}
			const seconds = record(value.usage).seconds;
			finish({
				finalized: true,
				reason: typeof value.reason === "string"
					? value.reason.slice(0, 80)
					: "closed",
				...(typeof seconds === "number" && Number.isFinite(seconds) &&
						seconds >= 0
					? { seconds }
					: {}),
			});
			return;
		}
		if (closing) return;
		// Reflected audio and unrelated provider events are discarded, never retained.
		if (
			![
				"session.input_transcript.delta",
				"session.output_transcript.delta",
				"session.delegation.created",
			].includes(String(value.type))
		) {
			return;
		}
		if (typeof value.event_id === "string") {
			if (seen.has(value.event_id)) return;
			if (seen.size >= 2_048 || value.event_id.length > 256) {
				void close();
				return;
			}
			seen.add(value.event_id);
		}
		if (value.type !== "session.delegation.created") {
			if (
				typeof value.delta !== "string" || value.delta.length > 4_096 ||
				typeof value.start_ms !== "number" ||
				!Number.isFinite(value.start_ms) || value.start_ms < 0 ||
				typeof value.end_ms !== "number" || !Number.isFinite(value.end_ms) ||
				value.end_ms < value.start_ms
			) {
				diagnostic({ stage: "message_ignored", code: "invalid_transcript" });
				return;
			}
			diagnostic({ stage: "transcript_accepted" });
			transcript.push({
				speaker: value.type === "session.input_transcript.delta"
					? "user"
					: "assistant",
				text: value.delta,
				startMs: value.start_ms,
				endMs: value.end_ms,
			});
			transcript.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
			while (
				transcript.length > 128 ||
				transcript.reduce((n, row) => n + row.text.length, 0) > 16_000
			) transcript.shift();
			return;
		}
		const delegation = record(value.delegation);
		if (
			delegation.target !== "client" || typeof delegation.id !== "string" ||
			!delegation.id || delegation.id.length > 256 ||
			typeof value.offset_ms !== "number" ||
			!Number.isFinite(value.offset_ms) || value.offset_ms < 0
		) {
			diagnostic({ stage: "delegation_ignored", code: "invalid_delegation" });
			return;
		}
		const delegationID = delegation.id, offsetMs = value.offset_ms;
		if (delegations.has(delegationID)) {
			diagnostic({ stage: "delegation_ignored", code: "duplicate" });
			return;
		}
		if (delegations.size >= 64 || pending >= 4) {
			void close();
			return;
		}
		delegations.add(delegationID);
		pending++;
		const context = transcript.filter((row) => row.startMs <= offsetMs).map((
			row,
		) => ({ ...row }));
		diagnostic({
			stage: "delegation_accepted",
			code: context.length ? "with_context" : "empty_context",
		});
		queue = queue.then(async () => {
			if (closing || terminal) return;
			const started = Date.now();
			diagnostic({ stage: "execution_started" });
			try {
				if (
					!await bounded(() => options.authorize(), 2_000, cancellation.signal)
				) {
					void close();
					return;
				}
				const result = await bounded(
					(signal) =>
						options.execute({
							delegationID,
							offsetMs,
							transcript: context,
							signal,
						}),
					workMs,
					cancellation.signal,
				);
				if (
					!await bounded(() => options.authorize(), 2_000, cancellation.signal)
				) {
					void close();
					return;
				}
				// A UTF-8 byte cap below 500 is conservative even for unusual tokenizer inputs.
				if (
					typeof result !== "string" || !result.trim() ||
					new TextEncoder().encode(result).length > 480
				) throw new Error("Invalid voice result");
				diagnostic({
					stage: "execution_completed",
					elapsedMs: Date.now() - started,
				});
				append(delegationID, result);
			} catch (error) {
				diagnostic({
					stage: "execution_failed",
					elapsedMs: Date.now() - started,
					code: error instanceof VoiceExecutionError
						? error.code
						: error instanceof Error &&
								["Canceled", "Deadline"].includes(error.message)
						? "deadline_or_cancelled"
						: "operation_failed",
				});
				if (!closing && !terminal) {
					append(
						delegationID,
						"I couldn't verify that information. Please try again.",
						true,
					);
				}
			} finally {
				pending--;
			}
		}).catch(() => {
			void close();
		});
	};
	const lost = () => finish({ finalized: false, reason: "connection_lost" });
	const listeners: [string, (event: { data?: unknown }) => void][] = [
		["message", message],
		["close", lost],
		["error", lost],
	];
	for (const [type, listener] of listeners) {
		socket.addEventListener(type, listener);
	}
	const lifeTimer = setTimeout(() => {
		void close();
	}, duration(options.limits?.lifetimeMs, 900_000));
	try {
		socket.accept();
		diagnostic({ stage: "socket_accepted" });
	} catch {
		finish({ finalized: false, reason: "attach_failed" });
		throw new Error("Voice control connection unavailable");
	}
	// The HTTP session already exists. Attach does not replay session.started, so
	// send once here, independently of reflected lifecycle events. This appends
	// instructions without replacing the startup prompt or triggering graph work.
	if (!terminal && !closing) {
		pendingGreeting = { id: crypto.randomUUID(), started: Date.now() };
		try {
			socket.send(JSON.stringify({
				type: "session.instructions.append",
				event_id: pendingGreeting.id,
				delegation_id: null,
				content:
					"Immediately greet the user naturally in English without waiting for them to speak. Choose your own brief wording appropriate to the conversation so far, including whether this is a new conversation or a continuation. Then pause and listen. Preserve all existing instructions. Do not look up data or delegate work for this greeting.",
			}));
			diagnostic({ stage: "greeting_sent" });
		} catch {
			pendingGreeting = undefined;
			diagnostic({ stage: "greeting_rejected", code: "operation_failed" });
		}
	}
	return { close, finished };
};
