export interface BriefingSection {
	partial: boolean;
	observedAt?: string;
	status: "available" | "unavailable";
	sourceFreshness: "unknown";
}
export interface DayBriefing {
	date: string;
	timeZone: string;
	fetchedAt: string;
	partial: boolean;
	sources: { id: string; title: string; url?: string }[];
	events: {
		id: string;
		title: string;
		start: string;
		end: string;
		allDay?: boolean;
	}[];
	sections?: { calendar: BriefingSection; github: BriefingSection };
	github: { id: string; title: string; action: string }[];
}
export interface AgentGrant {
	ownerID: string;
	grantID: string;
	expiresAt: number;
	allowsDayBriefing: boolean;
}
export interface CapabilityDependencies {
	currentGrant(ownerID: string, grantID: string): Promise<AgentGrant | null>;
	readDay(
		ownerID: string,
		input: { date: string; timeZone: string },
		signal: AbortSignal,
	): Promise<unknown>;
}

const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid briefing result");
	}
	return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 2000): string => {
	if (typeof value !== "string" || value.length > maximum) {
		throw new Error("Invalid briefing result");
	}
	return value;
};
const timestamp = (value: unknown): string => {
	const result = text(value, 64);
	if (!Number.isFinite(Date.parse(result))) {
		throw new Error("Invalid briefing result");
	}
	return result;
};
const list = (value: unknown): Record<string, unknown>[] => {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error("Invalid briefing result");
	}
	return value.map(record);
};
const sourceURL = (value: unknown): string | undefined => {
	if (value === undefined) return undefined;
	const url = new URL(text(value, 2048));
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Invalid briefing result");
	}
	return url.href;
};
/** Project each nested record; TypeScript alone cannot prevent runtime adapters
 * from returning internal credentials or other out-of-contract properties. */
const section = (value: unknown): BriefingSection => {
	const row = record(value);
	if (
		typeof row.partial !== "boolean" || row.sourceFreshness !== "unknown" ||
		!["available", "unavailable"].includes(String(row.status))
	) {
		throw new Error("Invalid briefing freshness");
	}
	return {
		partial: row.partial,
		status: row.status as "available" | "unavailable",
		...(row.status === "available"
			? { observedAt: timestamp(row.observedAt) }
			: {}),
		sourceFreshness: "unknown",
	};
};
const projectBriefing = (value: unknown): DayBriefing => {
	const row = record(value);
	if (typeof row.partial !== "boolean") {
		throw new Error("Invalid briefing result");
	}
	return {
		...(row.sections === undefined ? {} : {
			sections: {
				calendar: section(record(row.sections).calendar),
				github: section(record(row.sections).github),
			},
		}),
		date: text(row.date, 10),
		timeZone: text(row.timeZone, 100),
		fetchedAt: timestamp(row.fetchedAt),
		partial: row.partial,
		sources: list(row.sources).map((source) => {
			const url = sourceURL(source.url);
			return {
				id: text(source.id, 256),
				title: text(source.title),
				...(url ? { url } : {}),
			};
		}),
		events: list(row.events).map((event) => ({
			id: text(event.id, 256),
			title: text(event.title),
			start: timestamp(event.start),
			end: timestamp(event.end),
			...(typeof event.allDay === "boolean" ? { allDay: event.allDay } : {}),
		})),
		github: list(row.github).map((activity) => ({
			id: text(activity.id, 256),
			title: text(activity.title),
			action: text(activity.action, 128),
		})),
	};
};

/** These host functions become one Code Mode connector, not separate MCP tools.
 * Owner and grant are bound by the trusted coordinator, never model arguments. */
export const createDayCapabilities = (
	ownerID: string,
	grantID: string,
	dependencies: CapabilityDependencies,
) => {
	let calls = 0;
	const authorize = async () => {
		const grant = await dependencies.currentGrant(ownerID, grantID);
		if (
			!grant || grant.ownerID !== ownerID || grant.grantID !== grantID ||
			grant.expiresAt <= Date.now() || !grant.allowsDayBriefing
		) throw new Error("Capability unavailable");
	};
	return Object.freeze({
		briefing: async (
			input: { date: string; timeZone: string },
		): Promise<DayBriefing> => {
			if (++calls > 4) throw new Error("Read budget exhausted");
			if (
				!input || Object.keys(input).some((key) =>
					!["date", "timeZone"].includes(key)
				) ||
				typeof input.date !== "string" ||
				!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
				!Number.isFinite(Date.parse(`${input.date}T00:00:00Z`)) ||
				new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) !==
					input.date ||
				typeof input.timeZone !== "string" || input.timeZone.length > 100
			) throw new Error("Invalid day");
			try {
				new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
			} catch {
				throw new Error("Invalid time zone");
			}
			await authorize();
			const raw = await dependencies.readDay(
				ownerID,
				input,
				AbortSignal.timeout(5_000),
			);
			await authorize();
			const result = projectBriefing(raw);
			if (
				result.date !== input.date || result.timeZone !== input.timeZone ||
				JSON.stringify(result).length > 24_000
			) throw new Error("Invalid briefing result");
			return result;
		},
	});
};
