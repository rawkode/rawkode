import { workerName } from "../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import type { deploymentAccess } from "./access.ts";

export default (
	oauth: Cloudflare.Worker,
	google: Cloudflare.Worker,
	api: Cloudflare.Worker,
	documents: Cloudflare.Worker,
	access: Effect.Success<typeof deploymentAccess>,
) =>
	Effect.Do.pipe(
		Effect.bind("stage", () => Alchemy.Stage),
		Effect.bind("domain", () => Config.string("WEBSITE_DOMAIN")),
		Effect.let("origin", ({ domain }) => `https://${domain}`),
		Effect.flatMap(({ stage, domain, origin }) =>
			Cloudflare.Website.Astro("website", {
				name: workerName("website", stage),
				rootDir: fileURLToPath(new URL(".", import.meta.url)),
				sessionKVBindingName: false,
				workersDev: false,
				domain,
				compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
				astro: { output: "server", site: origin },
				env: {
					WEBSITE_ORIGIN: origin,
					ACCESS_TEAM_DOMAIN: access.teamDomain,
					ACCESS_AUDIENCE: access.audience,
					ADMIN_EMAILS: access.adminEmails,
					OAUTH: oauth,
					OAUTH_ADMIN: Cloudflare.WorkerEntrypoint(oauth, "OAuthAdmin"),
					GOOGLE_ADMIN: Cloudflare.WorkerEntrypoint(google, "CalendarAdmin"),
					API: api,
					DOCUMENTS_ADMIN: Cloudflare.WorkerEntrypoint(
						documents,
						"DocumentsAdmin",
					),
				},
			})
		),
	);
