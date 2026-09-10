import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

const optional = (name: string) =>
	Config.string(name).pipe(Config.withDefault(""));

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};

export const serviceCredential = (store: Cloudflare.SecretsStore.Store) =>
	Effect.flatMap(
		Alchemy.Stage,
		(stage) =>
			Effect.flatMap(
				Alchemy.Random("google-service-credential-material", { bytes: 32 }),
				(material) =>
					Cloudflare.SecretsStore.Secret("google-service-credential", {
						store,
						name: `e2-${stage}-integrations-google-credential`,
						value: material.text,
					}),
			),
	);

export default (
	oauth: Cloudflare.Worker,
	credential: Cloudflare.SecretsStore.Secret,
) =>
	Effect.flatMap(
		Alchemy.Stage,
		(stage) =>
			Cloudflare.Worker("integrations-google", {
				name: workerName("integrations-google", stage),
				...workerSource,
				workersDev: false,
				env: {
					GOOGLE_ACCOUNTS: Cloudflare.DurableObject("GoogleAccount", {
						className: "GoogleAccount",
					}),
					OAUTH: Cloudflare.WorkerEntrypoint(oauth, "OAuthIntegrations"),
					OAUTH_SERVICE_CREDENTIAL: credential,
					LOCAL_PROVIDER_ORIGIN: optional("LOCAL_PROVIDER_ORIGIN"),
					GMAIL_PUBSUB_TOPIC: optional("GMAIL_PUBSUB_TOPIC"),
					GMAIL_PUSH_AUDIENCE: optional("GMAIL_PUSH_AUDIENCE"),
					GMAIL_PUSH_SERVICE_ACCOUNT: optional("GMAIL_PUSH_SERVICE_ACCOUNT"),
					GMAIL_PUSH_SUBSCRIPTION: optional("GMAIL_PUSH_SUBSCRIPTION"),
				},
				crons: ["*/15 * * * *"],
			}),
	);
