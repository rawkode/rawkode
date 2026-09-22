import { workerName } from "../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import type * as Output from "alchemy/Output";

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};

export default (
	google: Cloudflare.Worker,
	github: Cloudflare.Worker,
	documents: Cloudflare.Worker,
	entities: Cloudflare.Worker,
	access: {
		teamDomain: string;
		audience: Output.Output<string>;
		adminEmails: string;
	},
) =>
	Effect.flatMap(Alchemy.Stage, (stage) =>
		Cloudflare.Worker("api", {
			name: workerName("api", stage),
			...workerSource,
			workersDev: false,
			env: {
				WEBSITE_ORIGIN: Config.string("WEBSITE_DOMAIN").pipe(
					Config.map((domain) => `https://${domain}`),
				),
				ACCESS_TEAM_DOMAIN: access.teamDomain,
				ACCESS_AUDIENCE: access.audience,
				ADMIN_EMAILS: access.adminEmails,
				DOCUMENTS_ADMIN: Cloudflare.WorkerEntrypoint(
					documents,
					"DocumentsAdmin",
				),
				ENTITIES_ADMIN: Cloudflare.WorkerEntrypoint(
					entities,
					"EntitiesAdmin",
				),
				GOOGLE_ADMIN: Cloudflare.WorkerEntrypoint(google, "CalendarAdmin"),
				GITHUB_ADMIN: Cloudflare.WorkerEntrypoint(github, "GitHubAdmin"),
			},
		}));
