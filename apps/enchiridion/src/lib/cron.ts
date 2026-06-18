const cronFieldRanges = [
	{ min: 0, max: 59 },
	{ min: 0, max: 23 },
	{ min: 1, max: 31 },
	{ min: 1, max: 12 },
	{ min: 0, max: 7 },
] as const;

export function cronMatches(cron: string, date: Date): boolean {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
		return false;
	}

	const minute = date.getUTCMinutes();
	const hour = date.getUTCHours();
	const dayOfMonth = date.getUTCDate();
	const month = date.getUTCMonth() + 1;
	const dayOfWeek = date.getUTCDay();

	if (!fieldMatches(fields[0] ?? "", minute, cronFieldRanges[0])) {
		return false;
	}
	if (!fieldMatches(fields[1] ?? "", hour, cronFieldRanges[1])) {
		return false;
	}
	if (!fieldMatches(fields[3] ?? "", month, cronFieldRanges[3])) {
		return false;
	}

	const domField = fields[2] ?? "";
	const dowField = fields[4] ?? "";
	const domWildcard = isWildcardField(domField);
	const dowWildcard = isWildcardField(dowField);
	const domMatches = fieldMatches(domField, dayOfMonth, cronFieldRanges[2]);
	const dowMatches = fieldMatches(dowField, dayOfWeek, cronFieldRanges[4])
		|| dayOfWeek === 0 && fieldMatches(dowField, 7, cronFieldRanges[4]);

	if (!domMatches && !dowMatches) {
		return false;
	}
	if (!domWildcard && !dowWildcard) {
		return domMatches || dowMatches;
	}
	return domMatches && dowMatches;
}

function fieldMatches(field: string, value: number, range: { min: number; max: number }): boolean {
	return field.split(",").some((part) => partMatches(part.trim(), value, range));
}

function partMatches(part: string, value: number, range: { min: number; max: number }): boolean {
	if (!part) {
		return false;
	}

	const [base = "", stepText] = part.split("/");
	const step = stepText === undefined ? 1 : Number(stepText);
	if (!Number.isInteger(step) || step < 1) {
		return false;
	}

	const bounds = boundsForBase(base, range);
	if (!bounds) {
		return false;
	}

	if (value < bounds.start || value > bounds.end) {
		return false;
	}

	return (value - bounds.start) % step === 0;
}

function boundsForBase(base: string, range: { min: number; max: number }): { start: number; end: number } | null {
	if (base === "*") {
		return { start: range.min, end: range.max };
	}

	const rangeSeparator = base.indexOf("-");
	if (rangeSeparator >= 0) {
		const start = Number(base.slice(0, rangeSeparator));
		const end = Number(base.slice(rangeSeparator + 1));
		if (!isInRange(start, range) || !isInRange(end, range) || start > end) {
			return null;
		}
		return { start, end };
	}

	const single = Number(base);
	if (!isInRange(single, range)) {
		return null;
	}
	return { start: single, end: single };
}

function isInRange(value: number, range: { min: number; max: number }): boolean {
	return Number.isInteger(value) && value >= range.min && value <= range.max;
}

function isWildcardField(field: string): boolean {
	return field === "*";
}
