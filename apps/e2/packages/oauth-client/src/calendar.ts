import type { Connection } from "./contracts.ts";

export interface CalendarEvent {
	id: string;
	summary?: string;
	status?: string;
	start?: { date?: string; dateTime?: string; timeZone?: string };
	end?: { date?: string; dateTime?: string; timeZone?: string };
	htmlLink?: string;
	[key: string]: unknown;
}

export interface CalendarApi {
	deleteAccount(connectionId: string): Promise<void>;
	mailPeople(
		connectionId: string,
		from: string,
		to: string,
	): Promise<{ people: { email: string; name: string }[]; partial: boolean }>;
	upcoming(
		connectionId: string,
		from: string,
		to: string,
	): Promise<
		{
			events: (CalendarEvent & {
				calendarId: string;
				calendarName: string;
				calendarColor?: string;
			})[];
			partial: boolean;
		}
	>;
	syncGoogle(
		connectionId: string,
	): Promise<{ changed: number; pending: boolean; syncedAt: number }>;
	listRecords(
		connectionId: string,
		collection: string,
		after?: string,
	): Promise<
		{
			records: { id: string; data: Record<string, unknown> }[];
			nextCursor?: string;
		}
	>;
	searchMail(
		connectionId: string,
		query: string,
		pageToken?: string,
	): Promise<
		{
			messages: { id: string; threadId: string }[];
			nextPageToken?: string;
			resultSizeEstimate: number;
		}
	>;
	watchMail(connectionId: string): Promise<{ expiration: number }>;
	mailStatus(
		connectionId: string,
	): Promise<
		| { expiration: number; history_id: string; notified_at: number | null }
		| null
	>;
	listConnections(): Promise<Connection[]>;
	sync(connectionId: string): Promise<{ changed: number; syncedAt: number }>;
	listEvents(
		connectionId: string,
	): Promise<{ events: CalendarEvent[]; syncedAt: number | null }>;
}
