const hashPart = (value: string): string => {
	let hash = 14695981039346656037n;
	for (const character of value) {
		hash ^= BigInt(character.codePointAt(0)!);
		hash = BigInt.asUintN(64, hash * 1099511628211n);
	}
	return hash.toString(36);
};

// Provider IDs are opaque and Google event IDs can be very long. Keep a short
// readable prefix, then add a deterministic hash so HTTP and Durable Object
// document keys stay bounded without collapsing distinct calendars/events.
const safePart = (value: string): string => {
	const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
	return normalized.length <= 28 && normalized === value
		? normalized
		: `${normalized.slice(0, 12)}-${hashPart(value)}`;
};

export const eventDocumentId = (
	connectionId: string,
	calendarId: string,
	eventId: string,
	recurringEventId = eventId,
): string =>
	`event:${safePart(connectionId)}:${safePart(calendarId)}:${
		safePart(recurringEventId)
	}:${safePart(eventId)}`;

export const eventSeriesDocumentId = (
	connectionId: string,
	calendarId: string,
	recurringEventId: string,
): string =>
	`event-series:${safePart(connectionId)}:${safePart(calendarId)}:${
		safePart(recurringEventId)
	}`;

export const eventSeriesDocumentPrefix = (
	connectionId: string,
	calendarId: string,
	recurringEventId: string,
): string =>
	`event:${safePart(connectionId)}:${safePart(calendarId)}:${
		safePart(recurringEventId)
	}:`;
