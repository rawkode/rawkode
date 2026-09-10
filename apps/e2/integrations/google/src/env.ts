import type { OAuthIntegrationBinding, SecretBinding } from "@e2/oauth-client";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import type { AccountDatabase } from "./storage.ts";
import type { EntitiesAdminBinding } from "./projection.ts";

interface GoogleAccountStub extends Rpc.DurableObjectBranded {
	start(connectionId: string, immediate?: boolean): Promise<void>;
	sync(connectionId: string, owner: string): ReturnType<CalendarApi["sync"]>;
	listRecords(
		connectionId: string,
		owner: string,
		collection: string,
		after?: string,
	): ReturnType<CalendarApi["listRecords"]>;
	searchMail(
		connectionId: string,
		owner: string,
		query: string,
		pageToken?: string,
	): ReturnType<CalendarApi["searchMail"]>;
	upcoming(
		connectionId: string,
		owner: string,
		from: string,
		to: string,
	): ReturnType<CalendarApi["upcoming"]>;
	watchMail(
		connectionId: string,
		owner: string,
	): ReturnType<CalendarApi["watchMail"]>;
	mailPeople(
		connectionId: string,
		owner: string,
		from: string,
		to: string,
	): ReturnType<CalendarApi["mailPeople"]>;
	mailStatus(
		connectionId: string,
		owner: string,
	): ReturnType<CalendarApi["mailStatus"]>;
	listEvents(
		connectionId: string,
		owner: string,
	): ReturnType<CalendarApi["listEvents"]>;
	deleteAccount(connectionId: string, owner: string): Promise<void>;
	notifyMail(
		connectionId: string,
		email: string,
		history: string,
	): Promise<void>;
}

export interface CalendarEnv {
	GOOGLE_ACCOUNTS: DurableObjectNamespace<GoogleAccountStub>;
	OAUTH: OAuthIntegrationBinding;
	OAUTH_SERVICE_CREDENTIAL: SecretBinding;
	/** Optional until deployment composition wires the canonical entity Worker. */
	ENTITIES_ADMIN?: EntitiesAdminBinding;
	LOCAL_PROVIDER_ORIGIN?: string;
	GMAIL_PUBSUB_TOPIC?: string;
	GMAIL_PUSH_AUDIENCE?: string;
	GMAIL_PUSH_SERVICE_ACCOUNT?: string;
	GMAIL_PUSH_SUBSCRIPTION?: string;
}

export interface AccountEnv extends CalendarEnv {
	DB: AccountDatabase;
}

export const calendarEndpoint = (env: CalendarEnv): string => {
	if (!env.LOCAL_PROVIDER_ORIGIN) {
		return "https://www.googleapis.com/calendar/v3/calendars/primary/events";
	}
	const url = new URL(env.LOCAL_PROVIDER_ORIGIN);
	if (
		url.origin !== env.LOCAL_PROVIDER_ORIGIN || url.protocol !== "http:" ||
		!["localhost", "127.0.0.1"].includes(url.hostname)
	) {
		throw new Error("The test provider must use an HTTP loopback origin.");
	}
	return `${url.origin}/calendar/v3/calendars/primary/events`;
};
