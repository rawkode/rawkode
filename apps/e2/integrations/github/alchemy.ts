import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
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
	app?: {
		entities: Cloudflare.Worker;
		store: Cloudflare.SecretsStore.Store;
	},
) =>
	Effect.flatMap(
		Alchemy.Stage,
		(stage) => {
			const createWorker = (appEnv: Record<string, unknown> = {}) =>
				Cloudflare.Worker("integrations-github", {
					name: workerName("integrations-github", stage),
					...workerSource,
					workersDev: false,
					env: {
						OAUTH: Cloudflare.WorkerEntrypoint(oauth, "OAuthIntegrations"),
						OAUTH_SERVICE_CREDENTIAL: credential,
						DB: Cloudflare.D1.Database("github-app-registry", {
							migrations: fileURLToPath(
								new URL("./migrations", import.meta.url),
							),
						}),
						GITHUB_INSTALLATIONS: Cloudflare.DurableObject(
							"GitHubInstallation",
							{ className: "GitHubInstallation" },
						),
						...appEnv,
					},
					crons: ["*/15 * * * *"],
				});
			if (!app) return createWorker();
			return Effect.all({
				privateKey: Cloudflare.SecretsStore.Secret("github-app-private-key", {
					store: app.store,
					name: `e2-${stage}-github-app-private-key`,
					value: Config.redacted("GITHUB_APP_PRIVATE_KEY"),
				}),
				webhookSecret: Cloudflare.SecretsStore.Secret(
					"github-app-webhook-secret",
					{
						store: app.store,
						name: `e2-${stage}-github-app-webhook-secret`,
						value: Config.redacted("GITHUB_APP_WEBHOOK_SECRET"),
					},
				),
			}).pipe(Effect.flatMap(({ privateKey, webhookSecret }) =>
				createWorker({
					ENTITIES_ADMIN: Cloudflare.WorkerEntrypoint(
						app.entities,
						"EntitiesAdmin",
					),
					GITHUB_APP_ID: Config.string("GITHUB_APP_ID"),
					GITHUB_APP_SLUG: Config.string("GITHUB_APP_SLUG"),
					GITHUB_APP_PRIVATE_KEY: privateKey,
					GITHUB_WEBHOOK_SECRET: webhookSecret,
				})
			));
		},
	);
