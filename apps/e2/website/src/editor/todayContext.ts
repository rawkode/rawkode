export interface TodayEvent {
	connectionId: string;
	id: string;
	calendarId: string | null;
	calendarName: string | null;
	summary: string;
	start: string | null;
	end: string | null;
	recurringEventId: string | null;
	attendees: { email: string; name: string }[];
}
export interface TodayPerson {
	connectionId: string;
	id: string;
	displayName: string;
	emails: string[];
}
export interface GitHubActivity {
	connectionId: string;
	id: string;
	resourceId: string;
	kind: string;
	title: string;
	url: string;
	repository: string;
	actor: string;
	createdAt: string;
	action: string;
}
export interface TodayData {
	me: {
		today: {
			googleEvents: TodayEvent[];
			googleEventsPartial: boolean;
			googlePeople: TodayPerson[];
			githubActivity: GitHubActivity[];
		};
	};
}
export const loadTodayContext = async (
	date: string,
): Promise<TodayData["me"]["today"]> => {
	const from = new Date(`${date}T00:00:00`);
	const to = new Date(from);
	to.setDate(to.getDate() + 1);
	const response = await fetch("/api/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query: `query TodaySidebar($date: String!, $from: String!, $to: String!) {
				me { today(date: $date, from: $from, to: $to) {
					googleEvents { connectionId id calendarId calendarName summary start end recurringEventId attendees { email name } }
					googleEventsPartial
					googlePeople { connectionId id displayName emails }
					githubActivity { connectionId id resourceId kind title url repository actor createdAt action }
				} }
			}`,
			variables: { date, from: from.toISOString(), to: to.toISOString() },
		}),
	});
	if (!response.ok) {
		throw new Error("Your connected services could not be loaded.");
	}
	const result = await response.json() as {
		data?: TodayData;
		errors?: unknown[];
	};
	if (result.errors?.length || !result.data?.me?.today) {
		throw new Error("Your connected services could not be loaded.");
	}
	return result.data.me.today;
};

export const isAllDayEvent = (event: TodayEvent): boolean =>
	!!event.start && /^\d{4}-\d{2}-\d{2}$/.test(event.start);
export const eventKey = (event: { connectionId: string; id: string }): string =>
	`${event.connectionId}:${event.id}`;
export const MIN_CALENDAR_EVENT_MINUTES = 24;

export interface CalendarSlot {
	event: TodayEvent;
	start: number;
	end: number;
	column: number;
	columns: number;
}
// Wall-clock minutes keep the axis aligned with local event times, including DST days.
export const layoutDayEvents = (
	events: TodayEvent[],
	date: string,
): CalendarSlot[] => {
	const dayStart = new Date(`${date}T00:00:00`);
	const dayEnd = new Date(dayStart);
	dayEnd.setDate(dayEnd.getDate() + 1);
	const slots = events.flatMap((event): CalendarSlot[] => {
		if (!event.start || isAllDayEvent(event)) return [];
		const start = new Date(event.start);
		if (!Number.isFinite(start.getTime())) return [];
		const parsedEnd = event.end ? new Date(event.end) : null;
		const end = parsedEnd && parsedEnd > start
			? parsedEnd
			: new Date(start.getTime() + 30 * 60000);
		if (end <= dayStart || start >= dayEnd) return [];
		const from = start < dayStart
			? 0
			: start.getHours() * 60 + start.getMinutes();
		const to = end >= dayEnd ? 1440 : end.getHours() * 60 + end.getMinutes();
		return [{
			event,
			start: from,
			end: Math.max(from + MIN_CALENDAR_EVENT_MINUTES, to),
			column: 0,
			columns: 1,
		}];
	}).sort((a, b) => a.start - b.start || b.end - a.end);
	let group: CalendarSlot[] = [];
	let groupEnd = -1;
	const finishGroup = () => {
		const columns = Math.max(1, ...group.map((slot) => slot.column + 1));
		for (const slot of group) slot.columns = columns;
		group = [];
	};
	for (const slot of slots) {
		if (slot.start >= groupEnd) finishGroup();
		const occupied = new Set(
			group.filter((other) => other.end > slot.start).map((other) =>
				other.column
			),
		);
		while (occupied.has(slot.column)) slot.column++;
		group.push(slot);
		groupEnd = Math.max(slot.end, group.length === 1 ? slot.end : groupEnd);
	}
	finishGroup();
	return slots;
};
