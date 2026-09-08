import type { OAuthIntegrationBinding } from "@enchiridion/oauth-client";
import type { GoogleAccount } from './account';
export interface CalendarEnv {
  DB: D1Database;
  GOOGLE_ACCOUNTS?: DurableObjectNamespace<GoogleAccount>;
  OAUTH: OAuthIntegrationBinding;
  OAUTH_SERVICE_CREDENTIAL: string;
  LOCAL_PROVIDER_ORIGIN?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  GMAIL_PUSH_AUDIENCE?: string;
  GMAIL_PUSH_SERVICE_ACCOUNT?: string;
  GMAIL_PUSH_SUBSCRIPTION?: string;
}

export function calendarEndpoint(env: CalendarEnv): string {
  if (!env.LOCAL_PROVIDER_ORIGIN) return "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const url = new URL(env.LOCAL_PROVIDER_ORIGIN);
  if (url.origin !== env.LOCAL_PROVIDER_ORIGIN || url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("The test provider must use an HTTP loopback origin.");
  }
  return `${url.origin}/calendar/v3/calendars/primary/events`;
}
