import type { Connection } from "@e2/oauth-client";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import {
	type ApiContext,
	type IntegrationSchema,
	requestMemo,
} from "../../api/src/context.ts";

const read = async <T>(
	context: ApiContext,
	action: (api: CalendarApi) => Promise<T>,
): Promise<T> => {
	context.consume();
	if (!context.env.GOOGLE_ADMIN) {
		throw new Error("Integration is not configured.");
	}
	using api = await context.env.GOOGLE_ADMIN.admin(context.identity.ownerId);
	return await action(api);
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const entries = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter((item) => item !== null && typeof item === "object")
		: [];
const connection = (source: unknown): Connection => source as Connection;
const page = async (
	source: unknown,
	args: Record<string, unknown>,
	context: ApiContext,
	collection: string,
	map: (data: Record<string, unknown>) => Record<string, unknown>,
) => {
	const result = await read(
		context,
		(api) =>
			api.listRecords(
				connection(source).id,
				collection,
				typeof args.after === "string" ? args.after : undefined,
			),
	);
	return {
		records: result.records.map(({ id, data }) => ({
			connectionId: connection(source).id,
			id,
			...map(data),
		})),
		nextCursor: result.nextCursor ?? null,
	};
};
const accounts = (context: ApiContext) =>
	requestMemo(
		context,
		"google.connections",
		() => read(context, (api) => api.listConnections()),
	);

const contact = (
	connectionId: string,
	id: string,
	data: Record<string, unknown>,
) => ({
	connectionId,
	id,
	displayName: text(entries(data.names)[0]?.displayName),
	emails: entries(data.emailAddresses).map((value) => text(value.value))
		.filter(Boolean),
	phones: entries(data.phoneNumbers).map((value) => text(value.value))
		.filter(Boolean),
});

const event = (
	connectionId: string,
	value: Record<string, unknown>,
	calendarId?: string,
	calendarName?: string,
) => ({
	connectionId,
	id: text(value.id),
	calendarId: calendarId ?? text(value.calendarId),
	calendarName: calendarName ?? text(value.calendarName),
	calendarColor: typeof value.calendarColor === "string" &&
			value.calendarColor.length === 7 &&
			/^#[0-9a-f]{6}$/i.test(value.calendarColor)
		? value.calendarColor
		: null,
	summary: text(value.summary),
	start: text((value.start as Record<string, unknown> | undefined)?.dateTime) ||
		text((value.start as Record<string, unknown> | undefined)?.date) || null,
	end: text((value.end as Record<string, unknown> | undefined)?.dateTime) ||
		text((value.end as Record<string, unknown> | undefined)?.date) || null,
	recurringEventId: text(value.recurringEventId) || null,
	htmlLink: text(value.htmlLink) || null,
	attendees: entries(value.attendees).map((attendee) => ({
		email: text(attendee.email),
		name: text(attendee.displayName) || text(attendee.email),
		responseStatus: text(attendee.responseStatus) || null,
	})).filter((attendee) => attendee.email),
});

const normalizeQuery = (value: unknown): string =>
	typeof value === "string" ? value.trim().toLocaleLowerCase() : "";

const todayEventResult = (
	context: ApiContext,
	date: string,
	fromValue?: string,
	toValue?: string,
) =>
	requestMemo(
		context,
		`google.today.events:${date}:${fromValue ?? ""}:${toValue ?? ""}`,
		async () => {
			const from = new Date(fromValue ?? `${date}T00:00:00.000Z`);
			const to = new Date(toValue ?? (from.getTime() + 86_400_000));
			const connections = await accounts(context);
			const results = await Promise.allSettled(
				connections.map(async (account) => {
					const result = await read(
						context,
						(api) =>
							api.upcoming(account.id, from.toISOString(), to.toISOString()),
					);
					return {
						events: result.events.map((value) =>
							event(account.id, value, value.calendarId, value.calendarName)
						),
						partial: result.partial,
					};
				}),
			);
			return {
				events: results.flatMap((result) =>
					result.status === "fulfilled" ? result.value.events : []
				).sort((left, right) => eventTimestamp(left) - eventTimestamp(right)),
				partial: results.some((result) =>
					result.status === "rejected" || result.value.partial
				),
			};
		},
	);
const todayEvents = (
	context: ApiContext,
	date: string,
	from?: string,
	to?: string,
) => todayEventResult(context, date, from, to).then(({ events }) => events);
const eventTimestamp = (value: ReturnType<typeof event>): number => {
	const parsed = Date.parse(value.start ?? "");
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};
const todayEventsPartial = (
	context: ApiContext,
	date: string,
	from?: string,
	to?: string,
) => todayEventResult(context, date, from, to).then(({ partial }) => partial);

export const todayTaggedPeople = async (context: ApiContext, date: string) => {
	if (!context.env.DOCUMENTS_ADMIN) return [];
	using documents = await context.env.DOCUMENTS_ADMIN.admin(
		context.identity.ownerId,
	);
	const document = await documents.get(`daily:${date}`);
	if (!document) return [];
	const references: {
		connectionId: string;
		id: string;
		label: string;
		meta?: string;
	}[] = [];
	const canonical: { entityId: string; label: string }[] = [];
	const walk = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		const object = value as Record<string, unknown>;
		if (object.type === "entity") {
			const entity = object.attrs && typeof object.attrs === "object"
				? (object.attrs as Record<string, unknown>).entity
				: undefined;
			if (entity && typeof entity === "object") {
				const reference = entity as Record<string, unknown>;
				if (reference.version === 1 && text(reference.entityId)) {
					canonical.push({
						entityId: text(reference.entityId),
						label: text(reference.displayText) || text(reference.fallbackLabel),
					});
				} else if (
					reference.provider === "google" && reference.kind === "person"
				) {
					const [connectionId, ...parts] = text(reference.id).split(":");
					references.push({
						connectionId: connectionId ?? "",
						id: parts.join(":") || text(reference.id),
						label: text(reference.label),
						meta: text(reference.meta) || undefined,
					});
				}
			}
		}
		Object.values(object).forEach(walk);
	};
	walk(document.note);
	if (canonical.length && context.env.ENTITIES_ADMIN) {
		using entities = await context.env.ENTITIES_ADMIN.admin(
			context.identity.ownerId,
		);
		for (const reference of canonical) {
			const sources = await entities.getEntitySources(reference.entityId);
			for (
				const source of sources.filter((candidate) =>
					candidate.provider === "google" &&
					candidate.resourceType === "contact"
				)
			) {
				references.push({
					connectionId: source.connectionId,
					id: source.resourceId,
					label: reference.label,
				});
			}
		}
	}
	return references;
};

const cachedPeople = (
	context: ApiContext,
	query: string,
) =>
	requestMemo(context, `google.people:${query}`, async () => {
		const connections = await accounts(context);
		const searchAccount = async (account: Connection) => {
			const records: ReturnType<typeof contact>[] = [];
			let after: string | undefined;
			for (let page = 0; page < 10; page++) {
				const result = await read(
					context,
					(api) => api.listRecords(account.id, "contacts", after),
				);
				records.push(
					...result.records.map(({ id, data }) =>
						contact(account.id, id, data)
					),
				);
				const matches = records.filter((value) =>
					!query ||
					[value.displayName, ...value.emails].some((field) =>
						field.toLocaleLowerCase().includes(query)
					)
				);
				if (!result.nextCursor || matches.length >= 20) {
					return matches.slice(0, 20);
				}
				after = result.nextCursor;
			}
			return records.filter((value) =>
				!query ||
				[value.displayName, ...value.emails].some((field) =>
					field.toLocaleLowerCase().includes(query)
				)
			).slice(0, 20);
		};
		const results = await Promise.allSettled(connections.map(searchAccount));
		return results.flatMap((result) =>
			result.status === "fulfilled" ? result.value : []
		).slice(0, 20);
	});

const cachedEvents = (context: ApiContext, query: string) =>
	requestMemo(
		context,
		`google.events:${query}`,
		async () => {
			const connections = await accounts(context);
			const searchCalendar = async (
				account: Connection,
				calendar: { id: string; name: string },
			) => {
				const records: ReturnType<typeof event>[] = [];
				let after: string | undefined;
				for (let page = 0; page < 10; page++) {
					const result = await read(
						context,
						(api) =>
							api.listRecords(account.id, `events:${calendar.id}`, after),
					);
					records.push(
						...result.records.map(({ data }) =>
							event(account.id, data, calendar.id, calendar.name)
						),
					);
					const matches = records.filter((value) =>
						!query || value.summary.toLocaleLowerCase().includes(query)
					);
					if (!result.nextCursor || matches.length >= 20 || !query) {
						return matches.slice(0, 20);
					}
					after = result.nextCursor;
				}
				return records.filter((value) =>
					!query || value.summary.toLocaleLowerCase().includes(query)
				).slice(0, 20);
			};
			const searchAccount = async (account: Connection) => {
				const calendars = await read(
					context,
					(api) => api.listRecords(account.id, "calendars"),
				);
				const accessible = calendars.records
					.filter(({ data }) =>
						["reader", "writer", "owner"].includes(text(data.accessRole))
					)
					.slice(0, 10);
				const results = await Promise.allSettled(
					accessible.map(({ id, data }) =>
						searchCalendar(account, {
							id,
							name: text(data.summary) || id,
						})
					),
				);
				return results.flatMap((result) =>
					result.status === "fulfilled" ? result.value : []
				);
			};
			const results = await Promise.allSettled(connections.map(searchAccount));
			const records = results.flatMap((result) =>
				result.status === "fulfilled" ? result.value : []
			);
			return records.filter((value) =>
				!query || value.summary.toLocaleLowerCase().includes(query)
			).slice(0, 20);
		},
	);

const todayPeople = (
	context: ApiContext,
	date: string,
	from?: string,
	to?: string,
) =>
	requestMemo(
		context,
		`google.today.people:${date}:${from ?? ""}:${to ?? ""}`,
		async () => {
			const events = await todayEvents(context, date, from, to);
			const people = events.flatMap((value) =>
				value.attendees.map((attendee) => ({
					connectionId: value.connectionId,
					id: `email:${attendee.email.toLocaleLowerCase()}`,
					displayName: attendee.name,
					emails: [attendee.email],
					phones: [],
				}))
			);
			const tagged = await todayTaggedPeople(context, date);
			return [
				...people,
				...tagged.map((value) => ({
					connectionId: value.connectionId,
					id: value.id,
					displayName: value.label,
					emails: value.meta ? [value.meta] : [],
					phones: [],
				})),
			].filter((value, index, all) =>
				all.findIndex((candidate) =>
					candidate.connectionId === value.connectionId &&
					candidate.id === value.id
				) === index
			);
		},
	);

export const googleGraphql: IntegrationSchema = {
	typeDefs: `
    extend type User { googleAccounts: [GoogleAccount!]! googleAccount(connectionId: ID!): GoogleAccount googlePeople(query: String!): [GoogleContact!]! googleEvents(query: String!): [GoogleEvent!]! }
    type GoogleAccount { id: ID! accountLabel: String! contacts(after: String): GoogleContactPage! calendars(after: String): GoogleCalendarPage! events(calendarId: ID!, after: String): GoogleEventPage! }
    type GoogleContact { id: ID! connectionId: ID! displayName: String! emails: [String!]! phones: [String!]! }
    type GoogleContactPage { records: [GoogleContact!]! nextCursor: String }
    type GoogleCalendar { id: ID! summary: String! }
    type GoogleCalendarPage { records: [GoogleCalendar!]! nextCursor: String }
    type GoogleEvent { id: ID! connectionId: ID! calendarId: ID calendarName: String calendarColor: String summary: String! start: String end: String recurringEventId: String htmlLink: String attendees: [GoogleAttendee!]! }
    type GoogleAttendee { email: String! name: String! responseStatus: String }
    type GoogleEventPage { records: [GoogleEvent!]! nextCursor: String }
    extend type Today {
      googleEvents: [GoogleEvent!]!
      googleEventsPartial: Boolean!
      googlePeople: [GoogleContact!]!
    }
  `,
	fields: {
		"User.googleAccounts": (_source, _args, context) => accounts(context),
		"User.googleAccount": async (_source, args, context) =>
			(await accounts(context)).find((row) => row.id === args.connectionId) ??
				null,
		"GoogleAccount.contacts": (source, args, context) =>
			page(source, args, context, "contacts", (data) => ({
				displayName: text(entries(data.names)[0]?.displayName),
				emails: entries(data.emailAddresses).map((value) => text(value.value))
					.filter(Boolean),
				phones: entries(data.phoneNumbers).map((value) => text(value.value))
					.filter(Boolean),
			})),
		"GoogleAccount.calendars": (source, args, context) =>
			page(
				source,
				args,
				context,
				"calendars",
				(data) => ({ summary: text(data.summary) }),
			),
		"GoogleAccount.events": (source, args, context) =>
			page(
				source,
				args,
				context,
				`events:${String(args.calendarId)}`,
				(data) => event(connection(source).id, data),
			),
		"User.googlePeople": (_source, args, context) =>
			cachedPeople(context, normalizeQuery(args.query)),
		"User.googleEvents": (_source, args, context) =>
			cachedEvents(context, normalizeQuery(args.query)),
		"Today.googleEvents": (source, _args, context) => {
			const today = source as { date?: string; from?: string; to?: string };
			return todayEvents(context, String(today.date), today.from, today.to);
		},
		"Today.googleEventsPartial": (source, _args, context) => {
			const today = source as { date?: string; from?: string; to?: string };
			return todayEventsPartial(
				context,
				String(today.date),
				today.from,
				today.to,
			);
		},
		"Today.googlePeople": (source, _args, context) => {
			const today = source as { date?: string; from?: string; to?: string };
			return todayPeople(context, String(today.date), today.from, today.to);
		},
	},
};
