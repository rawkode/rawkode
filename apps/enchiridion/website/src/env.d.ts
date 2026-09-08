import type { OAuthAdminBinding } from "@enchiridion/oauth-client";
import type { CalendarApi } from "@enchiridion/oauth-client/calendar";

declare global {
  namespace Cloudflare {
    interface Env {
      OAUTH_ADMIN: OAuthAdminBinding;
      OAUTH_CALLBACK: { fetch(request: Request): Promise<Response> };
      CALENDAR_ADMIN: { fetch(request: Request): Promise<Response>; admin(ownerId: string): Promise<CalendarApi & Disposable> };
      WEBSITE_ORIGIN: string;
      ACCESS_TEAM_DOMAIN?: string;
      ACCESS_AUDIENCE?: string;
      ADMIN_EMAILS?: string;
      LOCAL_ADMIN_EMAIL?: string;
    }
  }
  namespace App {
    interface Locals { admin?: { ownerId: string; email: string; local: boolean } }
  }
}
export {};
