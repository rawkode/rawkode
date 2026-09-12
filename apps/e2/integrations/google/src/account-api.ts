import { type Connection, connectOAuth } from "@e2/oauth-client";
import type { CalendarEvent } from "@e2/oauth-client/calendar";
import type { AccountEnv } from "./env.ts";
import { CalendarError, syncCalendar } from "./sync.ts";
import { syncGoogle as syncGoogleProvider } from "./mirror.ts";
import { scopes } from "./google.ts";
import {
	mailPeople as mailPeopleProvider,
	searchMail as searchMailProvider,
	watchMail as watchMailProvider,
} from "./gmail.ts";

const validateCollection = (collection: string, after: string) => {
	const supported = typeof collection === "string" &&
		(collection === "contacts" || collection === "calendars" ||
			(collection.startsWith("events:") && collection.length > 7));
	const validCursor = typeof after === "string" && after.length <= 2048;
	if (!supported || collection.length > 2100 || !validCursor) {
		throw new CalendarError("Invalid collection");
	}
};

const validateEventWindow = (from: string, to: string) => {
	const start = typeof from === "string" ? Date.parse(from) : NaN;
	const end = typeof to === "string" ? Date.parse(to) : NaN;
	const valid = Number.isFinite(start) && Number.isFinite(end) &&
		end > start && end - start <= 3 * 86400000;
	if (!valid) throw new CalendarError("Invalid event window");
};

const eventTimes = (event: CalendarEvent) => {
	const start = event.start?.dateTime ?? event.start?.date;
	const end = event.end?.dateTime ?? event.end?.date;
	return {
		start: typeof start === "string" ? Date.parse(start) : NaN,
		end: typeof end === "string" ? Date.parse(end) : NaN,
	};
};

type CalendarMetadata = { name: string; timeZone?: string; color?: string };

const dateInZone = (value: number, timeZone?: string) => {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			day: "2-digit",
			month: "2-digit",
			timeZone: timeZone || "UTC",
			year: "numeric",
		}).formatToParts(new Date(value));
		const fields = Object.fromEntries(
			parts.filter(({ type }) => type !== "literal").map((
				{ type, value },
			) => [type, value]),
		);
		return `${fields.year}-${fields.month}-${fields.day}`;
	} catch {
		return new Date(value).toISOString().slice(0, 10);
	}
};

const eventOverlaps = (
	event: CalendarEvent,
	calendar: CalendarMetadata,
	from: number,
	to: number,
) => {
	const startDate = event.start?.date;
	const endDate = event.end?.date;
	if (typeof startDate === "string" && typeof endDate === "string") {
		return startDate <= dateInZone(to - 1, calendar.timeZone) &&
			endDate > dateInZone(from, calendar.timeZone);
	}
	const { start, end } = eventTimes(event);
	return Number.isFinite(start) && Number.isFinite(end) && start < to &&
		end > from;
};

export const createAccountApi = (env: AccountEnv, owner: string) => {
	const run = async <T>(action: () => Promise<T>) => {
		try {
			return await action();
		} catch (error) {
			throw new CalendarError(
				error instanceof CalendarError
					? error.message
					: "Calendar access is unavailable. Check the account connection and service grant.",
			);
		}
	};
	const listConnections = () => {
		return run(async () => {
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return (await oauth.listConnections()).filter((row) =>
				row.ownerId === owner && row.providerId === "google" &&
				row.status === "connected"
			);
		});
	};
	const getConnection = async (id: string): Promise<Connection> => {
		if (typeof id !== "string") {
			throw new CalendarError("Select a calendar connection.");
		}
		const connection = (await listConnections()).find((row) => row.id === id);
		if (!connection) {
			throw new CalendarError("This calendar connection is not authorized.");
		}
		return connection;
	};
	const sync = (connectionId: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await syncCalendar(env, oauth, connection);
		});
	};
	const syncGoogle = (connectionId: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await syncGoogleProvider(env, oauth, connection);
		});
	};
	const listRecords = (
		connectionId: string,
		collection: string,
		after = "",
	) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			validateCollection(collection, after);
			if (
				!connection.scopes.includes(
					collection === "contacts" ? scopes.contacts : scopes.calendars,
				)
			) throw new CalendarError("Missing Google permissions");
			if (collection.startsWith("events:")) {
				const calendar = await env.DB.prepare(
					"SELECT 1 FROM google_records WHERE connection_id = ? AND collection = 'calendars' AND resource_id = ? AND deleted = 0 AND json_extract(data, '$.accessRole') IN ('reader','writer','owner')",
				).bind(connectionId, collection.slice(7)).first();
				if (!calendar) {
					throw new CalendarError("Calendar is no longer accessible");
				}
			}
			const { results } = await env.DB.prepare(
				"SELECT resource_id, data FROM google_records WHERE connection_id = ? AND collection = ? AND deleted = 0 AND resource_id > ? ORDER BY resource_id LIMIT 101",
			).bind(connectionId, collection, after).all<
				{ resource_id: string; data: string }
			>();
			return {
				records: results.slice(0, 100).map((r) => ({
					id: r.resource_id,
					data: JSON.parse(r.data) as Record<string, unknown>,
				})),
				nextCursor: results.length > 100 ? results[99].resource_id : undefined,
			};
		});
	};
	const searchMail = (
		connectionId: string,
		query: string,
		pageToken?: string,
	) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await searchMailProvider(env, oauth, connection, query, pageToken);
		});
	};
	const upcoming = (connectionId: string, from: string, to: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			if (!connection.scopes.includes(scopes.calendars)) {
				throw new CalendarError("Missing Google permissions");
			}
			validateEventWindow(from, to);
			const fromTime = Date.parse(from);
			const toTime = Date.parse(to);
			const [calendars, records, syncs] = await Promise.all([
				env.DB.prepare(
					"SELECT resource_id, data FROM google_records WHERE connection_id = ? AND collection = 'calendars' AND deleted = 0",
				).bind(connectionId).all<{ resource_id: string; data: string }>(),
				env.DB.prepare(
					"SELECT collection, resource_id, data FROM google_records WHERE connection_id = ? AND collection LIKE 'instances:%' AND deleted = 0",
				).bind(connectionId).all<{
					collection: string;
					resource_id: string;
					data: string;
				}>(),
				env.DB.prepare(
					"SELECT collection, synced_at, page_token FROM google_syncs WHERE connection_id = ?",
				).bind(connectionId).all<{
					collection: string;
					synced_at: number | null;
					page_token: string | null;
				}>(),
			]);
			const calendarsById = new Map<string, CalendarMetadata>(
				calendars.results.flatMap(
					({ resource_id, data }): [string, CalendarMetadata][] => {
						const parsed = JSON.parse(data) as {
							summary?: unknown;
							timeZone?: unknown;
							accessRole?: unknown;
							backgroundColor?: unknown;
						};
						const accessRole = parsed.accessRole;
						if (
							![
								"reader",
								"writer",
								"owner",
							].includes(String(accessRole))
						) return [];
						return [[
							resource_id,
							{
								color: typeof parsed.backgroundColor === "string" &&
										parsed.backgroundColor.length === 7 &&
										/^#[0-9a-f]{6}$/i.test(parsed.backgroundColor)
									? parsed.backgroundColor
									: undefined,
								name: typeof parsed.summary === "string" && parsed.summary
									? parsed.summary
									: resource_id,
								timeZone: typeof parsed.timeZone === "string"
									? parsed.timeZone
									: undefined,
							},
						]];
					},
				),
			);
			const events = records.results
				.map(({ collection, resource_id, data }) => {
					const calendarId = collection.slice("instances:".length);
					const value = JSON.parse(data) as CalendarEvent;
					const times = eventTimes(value);
					return {
						calendarId,
						calendar: calendarsById.get(calendarId),
						value,
						id: resource_id,
						...times,
					};
				})
				.filter(({ calendar, value }) =>
					Boolean(calendar) && value.status !== "cancelled" &&
					eventOverlaps(value, calendar!, fromTime, toTime)
				)
				.sort((left, right) => left.start - right.start)
				.map(({ calendarId, calendar, value, id }) => ({
					...value,
					id,
					calendarId,
					calendarName: calendar?.name ?? calendarId,
					calendarColor: calendar?.color,
				}));
			const syncByCollection = new Map(
				syncs.results.map((sync) => [sync.collection, sync]),
			);
			const isComplete = (collection: string) => {
				const sync = syncByCollection.get(collection);
				return Boolean(sync?.synced_at) && !sync?.page_token;
			};
			const partial = !isComplete("calendars") ||
				[...calendarsById.keys()].some((calendarId) =>
					!isComplete(`events:${calendarId}`) ||
					!isComplete(`instances:${calendarId}`)
				);
			return { events, partial };
		});
	};
	const watchMail = (connectionId: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await watchMailProvider(env, oauth, connection);
		});
	};
	const mailPeople = (connectionId: string, from: string, to: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			using oauth = await connectOAuth(env.OAUTH, env.OAUTH_SERVICE_CREDENTIAL);
			return await mailPeopleProvider(env, oauth, connection, from, to);
		});
	};
	const mailStatus = (connectionId: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			if (!connection.scopes.includes(scopes.gmail)) {
				throw new CalendarError("Missing Gmail permissions");
			}
			return await env.DB.prepare(
				"SELECT expiration, history_id, notified_at FROM gmail_watches WHERE connection_id = ?",
			).bind(connectionId).first<
				{ expiration: number; history_id: string; notified_at: number | null }
			>();
		});
	};
	const listEvents = (connectionId: string) => {
		return run(async () => {
			const connection = await getConnection(connectionId);
			if (!connection.scopes.includes(scopes.calendars)) {
				throw new CalendarError("Missing Google permissions");
			}
			const { results } = await env.DB.prepare(
				"SELECT data FROM calendar_events WHERE connection_id = ? ORDER BY COALESCE(json_extract(data, '$.start.dateTime'), json_extract(data, '$.start.date')), event_id LIMIT 500",
			)
				.bind(connectionId).all<{ data: string }>();
			const cursor = await env.DB.prepare(
				"SELECT synced_at FROM calendar_syncs WHERE connection_id = ? AND owner_id = ?",
			).bind(connectionId, owner).first<{ synced_at: number | null }>();
			return {
				events: results.map((row) => JSON.parse(row.data) as CalendarEvent),
				syncedAt: cursor?.synced_at ?? null,
			};
		});
	};
	return {
		listConnections,
		sync,
		syncGoogle,
		listRecords,
		searchMail,
		upcoming,
		watchMail,
		mailPeople,
		mailStatus,
		listEvents,
	};
};
