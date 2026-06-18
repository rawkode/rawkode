export function isoNow(): string {
	return new Date().toISOString();
}

export function todayDateKey(now = new Date()): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/London",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	return formatter.format(now);
}

export function titleForDailyNote(date: string): string {
	const parsed = new Date(`${date}T12:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) {
		return date;
	}

	const day = parsed.getUTCDate();
	const month = new Intl.DateTimeFormat("en-GB", {
		month: "long",
		timeZone: "UTC",
	}).format(parsed);

	return `${day}${ordinalSuffix(day)} ${month}, ${parsed.getUTCFullYear()}`;
}

function ordinalSuffix(day: number): string {
	const remainder = day % 100;
	if (remainder >= 11 && remainder <= 13) {
		return "th";
	}

	if (day % 10 === 1) {
		return "st";
	}
	if (day % 10 === 2) {
		return "nd";
	}
	if (day % 10 === 3) {
		return "rd";
	}
	return "th";
}

export function addDays(date: string, delta: number): string {
	const next = new Date(`${date}T12:00:00.000Z`);
	next.setUTCDate(next.getUTCDate() + delta);
	return next.toISOString().slice(0, 10);
}
