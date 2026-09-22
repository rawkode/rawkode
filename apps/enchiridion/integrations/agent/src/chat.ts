import { REASONING_DEADLINE_MS } from "./reasoner-budget.ts";
import type {
	VoiceDelegationRequest,
	VoiceTranscriptFragment,
} from "./sideband.ts";

export interface ChatInput {
	message: string;
	history: readonly { role: "user" | "assistant"; content: string }[];
	timeZone?: string;
}
export const parseChatInput = (value: unknown): ChatInput => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid chat");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) =>
			!["message", "history", "timeZone"].includes(key)
		) || typeof input.message !== "string" || !input.message.trim() ||
		input.message.length > 4000 || !Array.isArray(input.history) ||
		input.history.length > 20
	) throw new Error("Invalid chat");
	const history = input.history.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Invalid history");
		}
		const row = value as Record<string, unknown>;
		if (
			Object.keys(row).some((key) => !["role", "content"].includes(key)) ||
			!["user", "assistant"].includes(String(row.role)) ||
			typeof row.content !== "string" || !row.content.trim() ||
			row.content.length > 4000
		) throw new Error("Invalid history");
		return { role: row.role as "user" | "assistant", content: row.content };
	});
	if (
		history.reduce(
			(size, row) => size + row.content.length,
			input.message.length,
		) > 16000
	) throw new Error("Chat too large");
	if (input.timeZone !== undefined) {
		if (typeof input.timeZone !== "string" || input.timeZone.length > 100) {
			throw new Error("Invalid timezone");
		}
		new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format();
	}
	return {
		message: input.message,
		history,
		...input.timeZone ? { timeZone: input.timeZone as string } : {},
	};
};
export const chatDelegation = (
	input: ChatInput,
	signal: AbortSignal,
): VoiceDelegationRequest => ({
	delegationID: crypto.randomUUID(),
	offsetMs: 0,
	signal,
	transcript: [...input.history, {
		role: "user" as const,
		content: input.message,
	}].map((row, index): VoiceTranscriptFragment => ({
		speaker: row.role,
		text: row.content,
		startMs: index,
		endMs: index,
	})),
});
export const readChatInput = async (request: Request): Promise<ChatInput> => {
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing chat body");
	let expired = false, size = 0;
	const timer = setTimeout(() => {
		expired = true;
		void reader.cancel().catch(() => {});
	}, 5000);
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 70000) {
				await reader.cancel();
				throw new Error("Chat too large");
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	if (expired) throw new Error("Chat body timed out");
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return parseChatInput(JSON.parse(new TextDecoder().decode(bytes)));
};
export const runChat = async (
	input: ChatInput,
	parent: AbortSignal,
	execute: (
		request: VoiceDelegationRequest,
		input: ChatInput,
	) => Promise<string>,
	milliseconds = REASONING_DEADLINE_MS,
): Promise<string> => {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	parent.addEventListener("abort", cancel, { once: true });
	if (parent.aborted) cancel();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const canceled = new Promise<never>((_, reject) => {
			controller.signal.addEventListener(
				"abort",
				() => reject(new Error("Chat outcome unconfirmed")),
				{ once: true },
			);
			if (controller.signal.aborted) {
				reject(new Error("Chat outcome unconfirmed"));
			}
			timer = setTimeout(() => controller.abort(), milliseconds);
		});
		if (controller.signal.aborted) throw new Error("Chat canceled");
		const text = await Promise.race([
			execute(chatDelegation(input, controller.signal), input),
			canceled,
		]);
		if (!text.trim() || new TextEncoder().encode(text).length > 16000) {
			throw new Error("Invalid chat response");
		}
		return text;
	} finally {
		clearTimeout(timer);
		controller.abort();
		parent.removeEventListener("abort", cancel);
	}
};
