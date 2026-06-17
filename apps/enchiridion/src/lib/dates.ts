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
	return `Daily Note ${date}`;
}

export function addDays(date: string, delta: number): string {
	const next = new Date(`${date}T12:00:00.000Z`);
	next.setUTCDate(next.getUTCDate() + delta);
	return next.toISOString().slice(0, 10);
}
