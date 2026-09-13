import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import type { deploymentAccess } from "../../website/access.ts";
import { bindStoredVoiceSecret } from "./stored-secret.ts";

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};
export default (
	api: Cloudflare.Worker,
	access: Effect.Success<typeof deploymentAccess>,
	store: Cloudflare.SecretsStore.Store,
) =>
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		const domain = yield* Config.string("WEBSITE_DOMAIN");
		const key = stage === "production"
			? undefined
			: yield* Cloudflare.SecretsStore.Secret("agent-openai-api-key", {
				store,
				name: `e2-${stage}-agent-openai-api-key`,
				value: Config.redacted("OPENAI_API_KEY"),
			});
		const worker = yield* Cloudflare.Worker("integrations-agent", {
			name: workerName("integrations-agent", stage),
			...workerSource,
			workersDev: false,
			env: {
				LOADER: Cloudflare.WorkerLoader("voice-code-loader"),
				VOICE_OWNERS: Cloudflare.DurableObject("VoiceOwner", {
					className: "VoiceOwner",
				}),
				...(key ? { OPENAI_API_KEY: key } : {}),
				API: api,
				WEBSITE_ORIGIN: `https://${domain}`,
				ACCESS_TEAM_DOMAIN: access.teamDomain,
				ACCESS_AUDIENCE: access.audience,
				ADMIN_EMAILS: access.adminEmails,
			},
		});
		if (stage === "production") yield* bindStoredVoiceSecret(worker);
		return worker;
	});
