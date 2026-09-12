import type { ApiContext, IntegrationSchema } from "./context.ts";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (value: unknown): value is string => {
	if (typeof value !== "string" || !datePattern.test(value)) return false;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed) &&
		new Date(parsed).toISOString().slice(0, 10) === value;
};
const validDate = (value: unknown): string =>
	isValidDate(value) ? value : new Date().toISOString().slice(0, 10);
const validBound = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length > 40) return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

export const todayGraphql: IntegrationSchema = {
	typeDefs: "",
	fields: {
		"User.today": (_source, args, _context: ApiContext) => {
			const date = validDate(args.date);
			const suppliedFrom = validBound(args.from);
			const suppliedTo = validBound(args.to);
			const fromTime = suppliedFrom ? Date.parse(suppliedFrom) : NaN;
			const toTime = suppliedTo ? Date.parse(suppliedTo) : NaN;
			const validRange = Number.isFinite(fromTime) && Number.isFinite(toTime) &&
				toTime > fromTime && toTime - fromTime <= 3 * 86_400_000;
			const from = validRange ? suppliedFrom! : `${date}T00:00:00.000Z`;
			const to = validRange
				? suppliedTo!
				: new Date(Date.parse(from) + 86_400_000).toISOString();
			return { id: `daily:${date}`, date, from, to };
		},
	},
};
