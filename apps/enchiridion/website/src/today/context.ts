import type { CalendarEvent } from '@enchiridion/oauth-client/calendar';
type Event = CalendarEvent & {
	calendarId: string;
	calendarName: string;
	attendees?: {
		email?: string;
		displayName?: string;
		self?: boolean;
		responseStatus?: string;
	}[];
};
export function dayKey(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseDay(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid day');
	const date = new Date(`${value}T12:00:00`);
	if (!Number.isFinite(date.getTime()) || dayKey(date) !== value)
		throw new Error('Invalid day');
	return date;
}
function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text: string,
) {
	const item = document.createElement(tag);
	item.className = className;
	item.textContent = text;
	return item;
}
export async function loadContext(day: string) {
	const list = document.querySelector('#agenda-list');
	if (!list && !document.querySelector('#people-list')) return;
	const start = parseDay(day);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	try {
		const response = await fetch(
			`/api/today?${new URLSearchParams({ from: start.toISOString(), to: end.toISOString() })}`,
			{ signal: AbortSignal.timeout(20_000) },
		);
		if (!response.ok) throw new Error('Unavailable');
		const result = (await response.json()) as {
			events: Event[];
			partial: boolean;
			connected: boolean;
			mailPeople?: { email: string; name: string }[];
			mailPartial?: boolean;
		};
		const events = result.events
			.filter((event) => {
				const from = event.start?.dateTime
					? Date.parse(event.start.dateTime)
					: new Date(`${event.start?.date}T00:00:00`).getTime();
				const to = event.end?.dateTime
					? Date.parse(event.end.dateTime)
					: new Date(
							`${event.end?.date || event.start?.date}T23:59:59`,
						).getTime();
				return from < end.getTime() && to > start.getTime();
			})
			.sort((a, b) =>
				(a.start?.dateTime || a.start?.date || '').localeCompare(
					b.start?.dateTime || b.start?.date || '',
				),
			);
		list?.replaceChildren();
		const people = new Map<string, { name: string; context: string }>();
		const seen = new Set<string>();
		for (const event of events) {
			const key = `${event.calendarId}:${event.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const row = element('div', 'agenda-item', '');
			const date = event.start?.dateTime && new Date(event.start.dateTime);
			const time = date
				? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
				: 'All day';
			row.append(element('span', 'agenda-time', time));
			const details = element('div', '', '');
			details.append(
				element('span', 'agenda-title', event.summary || 'Untitled event'),
				element('p', 'agenda-calendar', event.calendarName),
			);
			row.append(details);
			list?.append(row);
			if (
				date &&
				event.end?.dateTime &&
				date.getTime() <= Date.now() &&
				Date.parse(event.end.dateTime) > Date.now()
			)
				row.classList.add('agenda-now');
			for (const person of event.attendees ?? [])
				if (
					person.email &&
					!person.self &&
					person.responseStatus !== 'declined'
				)
					people.set(person.email.toLowerCase(), {
						name: person.displayName || person.email,
						context: event.summary || 'Calendar event',
					});
		}
		if (!seen.size)
			list?.append(
				element(
					'p',
					'context-empty',
					result.partial
						? 'No events loaded. Some calendars are unavailable; this may not be your complete day.'
						: result.connected
							? 'Nothing on the calendar. A little room to make the day your own.'
							: 'Connect a Google account to bring your calendar into view.',
				),
			);
		const eventCount = document.querySelector('#event-count');
		if (eventCount)
			eventCount.textContent = `${seen.size} event${seen.size === 1 ? '' : 's'}`;
		const agendaStatus = document.querySelector('#agenda-status');
		if (agendaStatus)
			agendaStatus.textContent = result.partial
				? 'Some calendars could not be loaded. This is a partial view.'
				: result.connected
					? 'Live events from your synced calendars.'
					: 'Your document is ready, with or without a calendar.';
		document.querySelector('#day-summary')!.textContent = seen.size
			? `${seen.size} thing${seen.size === 1 ? '' : 's'} on the calendar. The rest is yours to shape.`
			: 'A place for what’s on your mind.';
		const peopleList = document.querySelector('#people-list');
		for (const person of result.mailPeople ?? []) {
			const existing = people.get(person.email);
			people.set(person.email, {
				name: existing?.name || person.name,
				context: existing ? `${existing.context} · Email` : 'Email today',
			});
		}
		const provenance = document.querySelector('#people-provenance');
		if (provenance)
			provenance.textContent = result.mailPartial
				? 'Calendar attendees and a partial view of email participants.'
				: 'Calendar attendees and recent email participants. No messages stored.';
		if (peopleList) {
			peopleList.replaceChildren();
			for (const [email, person] of [...people].slice(0, 8)) {
				const row = element('div', 'person', '');
				const initials = person.name
					.split(/\s+/)
					.map((p) => p[0])
					.slice(0, 2)
					.join('')
					.toUpperCase();
				row.append(element('span', 'person-avatar', initials));
				const details = element('div', 'person-name', person.name);
				details.title = email;
				details.append(element('span', 'person-context', person.context));
				row.append(details);
				peopleList.append(row);
			}
			if (!people.size)
				peopleList.append(
					element(
						'p',
						'context-empty',
						'A quiet day for connections. Event attendees will appear here.',
					),
				);
			document.querySelector('#people-count')!.textContent = String(
				people.size,
			);
		}
	} catch {
		list?.replaceChildren(
			element(
				'p',
				'context-empty',
				'Calendar is unavailable right now. Writing is independent of your calendar.',
			),
		);
		const peopleList = document.querySelector('#people-list');
		peopleList?.replaceChildren(
			element(
				'p',
				'context-empty',
				'People could not be loaded. Try again later.',
			),
		);
	}
}
