import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};

export const serviceCredential = (store: Cloudflare.SecretsStore.Store) =>
	Effect.flatMap(
		Alchemy.Stage,
		(stage) =>
			Effect.flatMap(
				Alchemy.Random("github-service-credential-material", { bytes: 32 }),
				(material) =>
					Cloudflare.SecretsStore.Secret("github-service-credential", {
						store,
						name: `e2-${stage}-integrations-github-credential`,
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
			Cloudflare.Worker("integrations-github", {
				name: workerName("integrations-github", stage),
				...workerSource,
				workersDev: false,
				env: {
					OAUTH: Cloudflare.WorkerEntrypoint(oauth, "OAuthIntegrations"),
					OAUTH_SERVICE_CREDENTIAL: credential,
				},
			}),
	);
