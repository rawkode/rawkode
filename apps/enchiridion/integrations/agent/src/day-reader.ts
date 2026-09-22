import { Temporal } from "@js-temporal/polyfill";
import {
	type AuthConfig,
	authenticate,
} from "../../../website/src/lib/auth.ts";
import type { DayBriefing } from "./capabilities.ts";

export interface DayApiBinding {
	fetch(request: Request): Promise<Response>;
}
export const dayBriefingQueries = {
	calendar:
		`query AgentCalendarDay($date: String!, $from: String!, $to: String!) {
  me { id today(date: $date, from: $from, to: $to) {
    date from to googleEventsPartial
    googleEvents { id connectionId calendarId summary start end htmlLink }
  } }
}`,
	github: `query AgentGitHubDay($date: String!, $from: String!, $to: String!) {
  me { id today(date: $date, from: $from, to: $to) {
    date from to githubActivityPartial
    githubActivity { id connectionId title action url }
  } }
}`,
};
class DayAuthorizationError extends Error {}
export const dayBounds = (date: string, timeZone: string) => {
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeZone || timeZone.length > 100 ||
		/^[+-]/.test(timeZone)
	) throw new Error("Invalid day");
	new Intl.DateTimeFormat("en", { timeZone }); // Named IANA identifier, not a raw offset.
	const day = Temporal.PlainDate.from(date);
	const start = day.toZonedDateTime(timeZone);
	if (start.toPlainDate().toString() !== date) {
		throw new Error("This civil date does not exist in the selected time zone");
	}
	const end = day.add({ days: 1 }).toZonedDateTime(timeZone);
	return { from: start.toInstant().toString(), to: end.toInstant().toString() };
};
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid day response");
	}
	return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 400): string => {
	if (typeof value !== "string") throw new Error("Invalid day response");
	return value.slice(0, maximum);
};
const identifier = (value: unknown): string => {
	if (typeof value !== "string" || !value || value.length > 512) {
		throw new Error("Invalid source identifier");
	}
	return encodeURIComponent(value);
};
const sourceID = async (kind: string, parts: unknown[]): Promise<string> => {
	const serialized = JSON.stringify(parts.map(identifier));
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)),
	);
	return `${kind}:${
		Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
	}`;
};
const safeURL = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
};
const instant = (value: unknown, timeZone: string): string => {
	if (typeof value !== "string") throw new Error("Missing event time");
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayBounds(value, timeZone).from;
	return Temporal.Instant.from(value).toString();
};
const readBody = async (
	response: Response,
	signal: AbortSignal,
): Promise<unknown> => {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty day response");
	let size = 0;
	const chunks: Uint8Array[] = [];
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	try {
		for (;;) {
			signal.throwIfAborted();
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 262_144) {
				await reader.cancel();
				throw new Error("Day response exceeds byte budget");
			}
			chunks.push(value);
		}
		signal.throwIfAborted();
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.length;
		}
		return JSON.parse(new TextDecoder().decode(body));
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
};

/** Authenticate before constructing the closure. Only the coordinator receives
 * this object; generated code cannot replace its assertion, binding or owner. */
export const createApiDayReader = async (
	request: Request,
	config: AuthConfig,
	api: DayApiBinding,
	options: {
		authenticate?: typeof authenticate;
		timeoutMs?: number;
		sourceTimeoutMs?: number;
		clock?: () => Date;
	} = {},
) => {
	const identity = await (options.authenticate ?? authenticate)(
		request,
		config,
	);
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!identity || !assertion || assertion.length > 16_384) {
		throw new Error("Unauthorized day reader");
	}
	const boundOwner = identity.ownerId;
	const endpoint = new URL("/api/graphql", config.WEBSITE_ORIGIN);
	if (endpoint.protocol !== "https:") throw new Error("Invalid API origin");
	return async (
		ownerID: string,
		input: { date: string; timeZone: string },
		signal: AbortSignal,
	): Promise<DayBriefing> => {
		if (ownerID !== boundOwner) throw new Error("Day reader owner mismatch");
		if (Object.keys(input).some((key) => !["date", "timeZone"].includes(key))) {
			throw new Error("Invalid day arguments");
		}
		const date = input.date, timeZone = input.timeZone;
		const bounds = dayBounds(date, timeZone);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			controller.signal.addEventListener(
				"abort",
				() =>
					reject(
						controller.signal.reason instanceof DayAuthorizationError
							? controller.signal.reason
							: new Error("Day read cancelled or timed out"),
					),
				{ once: true },
			);
			timer = setTimeout(abort, options.timeoutMs ?? 5_000);
			if (controller.signal.aborted) {
				reject(new Error("Day read cancelled or timed out"));
			}
		});
		const loadSection = async (kind: keyof typeof dayBriefingQueries) => {
			const sourceController = new AbortController();
			const abortSource = () => sourceController.abort();
			controller.signal.addEventListener("abort", abortSource, { once: true });
			if (controller.signal.aborted) abortSource();
			let sourceTimer: ReturnType<typeof setTimeout> | undefined;
			const failed = new Promise<never>((_, reject) => {
				sourceController.signal.addEventListener(
					"abort",
					() => reject(new Error("Source read cancelled or timed out")),
					{ once: true },
				);
				sourceTimer = setTimeout(
					abortSource,
					Math.min(
						options.sourceTimeoutMs ?? 2_000,
						(options.timeoutMs ?? 5_000) * 0.75,
					),
				);
				if (sourceController.signal.aborted) {
					reject(new Error("Source read cancelled"));
				}
			});
			const fetchSection = async () => {
				sourceController.signal.throwIfAborted();
				const response = await api.fetch(
					new Request(endpoint, {
						method: "POST",
						redirect: "manual",
						signal: sourceController.signal,
						headers: {
							"Content-Type": "application/json",
							Origin: endpoint.origin,
							"Cf-Access-Jwt-Assertion": assertion,
						},
						body: JSON.stringify({
							query: dayBriefingQueries[kind],
							variables: { date, ...bounds },
						}),
					}),
				);
				if (sourceController.signal.aborted) {
					await response.body?.cancel();
					sourceController.signal.throwIfAborted();
				}
				if (!response.ok) {
					await response.body?.cancel();
					if (response.status === 401 || response.status === 403) {
						throw new DayAuthorizationError("Day API permission changed");
					}
					throw new Error("Day API unavailable");
				}
				const envelope = record(
					await readBody(response, sourceController.signal),
				);
				const me = record(record(envelope.data).me);
				if (me.id !== boundOwner) {
					throw new DayAuthorizationError("Day API owner mismatch");
				}
				if (Array.isArray(envelope.errors) && envelope.errors.length) {
					throw new Error("Day API returned incomplete GraphQL data");
				}
				const today = record(me.today);
				if (
					today.date !== date ||
					Temporal.Instant.from(text(today.from, 64)).epochMilliseconds !==
						Temporal.Instant.from(bounds.from).epochMilliseconds ||
					Temporal.Instant.from(text(today.to, 64)).epochMilliseconds !==
						Temporal.Instant.from(bounds.to).epochMilliseconds
				) throw new Error("Day API range mismatch");
				const items =
					today[kind === "calendar" ? "googleEvents" : "githubActivity"];
				const partial = today[
					kind === "calendar" ? "googleEventsPartial" : "githubActivityPartial"
				];
				if (!Array.isArray(items) || typeof partial !== "boolean") {
					throw new Error("Day API completion metadata unavailable");
				}
				return {
					items,
					partial,
					observedAt: (options.clock ?? (() => new Date()))().toISOString(),
				};
			};
			try {
				return await Promise.race([fetchSection(), failed]);
			} catch (error) {
				if (error instanceof DayAuthorizationError) {
					controller.abort(error);
					throw error;
				}
				controller.signal.throwIfAborted();
				return undefined;
			} finally {
				if (sourceTimer !== undefined) clearTimeout(sourceTimer);
				controller.signal.removeEventListener("abort", abortSource);
			}
		};
		const read = async () => {
			const [calendarResult, githubResult] = await Promise.all([
				loadSection("calendar"),
				loadSection("github"),
			]);
			controller.signal.throwIfAborted();
			const calendarItems = calendarResult?.items ?? [],
				githubItems = githubResult?.items ?? [];
			let calendarPartial = !calendarResult || calendarResult.partial ||
				calendarItems.length > 20;
			let githubPartial = !githubResult || githubResult.partial ||
				githubItems.length > 20;
			const sources: DayBriefing["sources"] = [],
				events: DayBriefing["events"] = [],
				github: DayBriefing["github"] = [];
			for (const value of calendarItems.slice(0, 20)) {
				try {
					const event = record(value);
					const id = await sourceID("google", [
						event.connectionId,
						event.calendarId || "unspecified",
						event.id,
					]);
					const title = text(event.summary),
						start = instant(event.start, timeZone),
						end = instant(event.end, timeZone);
					if (Temporal.Instant.compare(start, end) >= 0) {
						throw new Error("Invalid event range");
					}
					const url = safeURL(event.htmlLink);
					events.push({
						id,
						title,
						start,
						end,
						allDay: typeof event.start === "string" &&
							/^\d{4}-\d{2}-\d{2}$/.test(event.start),
					});
					sources.push({ id, title, ...(url ? { url } : {}) });
				} catch {
					calendarPartial = true;
				}
			}
			for (const value of githubItems.slice(0, 20)) {
				try {
					const activity = record(value),
						id = await sourceID("github", [activity.connectionId, activity.id]);
					const title = text(activity.title),
						action = text(activity.action, 128),
						url = safeURL(activity.url);
					github.push({ id, title, action });
					sources.push({ id, title, ...(url ? { url } : {}) });
				} catch {
					githubPartial = true;
				}
			}
			const fetchedAt = (options.clock ?? (() => new Date()))().toISOString();
			const result: DayBriefing = {
				date,
				timeZone,
				fetchedAt,
				partial: calendarPartial || githubPartial,
				sources,
				events,
				github,
				sections: {
					calendar: {
						partial: calendarPartial,
						status: calendarResult ? "available" : "unavailable",
						...(calendarResult
							? { observedAt: calendarResult.observedAt }
							: {}),
						sourceFreshness: "unknown",
					},
					github: {
						partial: githubPartial,
						status: githubResult ? "available" : "unavailable",
						...(githubResult ? { observedAt: githubResult.observedAt } : {}),
						sourceFreshness: "unknown",
					},
				},
			};
			while (new TextEncoder().encode(JSON.stringify(result)).length > 20_000) {
				const removed = github.pop() ?? events.pop();
				if (!removed) throw new Error("Day result exceeds budget");
				const index = sources.findIndex((source) => source.id === removed.id);
				if (index >= 0) sources.splice(index, 1);
				result.partial = true;
				result
					.sections![removed.id.startsWith("github:") ? "github" : "calendar"]
					.partial = true;
			}
			return result;
		};
		try {
			return await Promise.race([read(), timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	};
};
