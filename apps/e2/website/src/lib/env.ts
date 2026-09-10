import type { DocumentsApi } from "../../../core/documents/src/types.ts";
import { env } from "cloudflare:workers";
import type { OAuthAdminApi } from "@e2/oauth-client/contracts";
import type { CalendarApi } from "@e2/oauth-client/calendar";
import type { AuthConfig } from "./auth.ts";

type Remote<T> = T & Disposable;

export interface WebsiteEnv extends AuthConfig {
	API: Fetcher;
	DOCUMENTS_ADMIN: { admin(owner: string): Promise<Remote<DocumentsApi>> };
	OAUTH: Fetcher;
	OAUTH_ADMIN: { admin(owner: string): Promise<Remote<OAuthAdminApi>> };
	GOOGLE_ADMIN: { admin(owner: string): Promise<Remote<CalendarApi>> };
}

export const bindings = env as unknown as WebsiteEnv;
