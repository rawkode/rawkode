import { workerName } from "../../naming.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "alchemy/Output";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

export const workerSource = {
	main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
	compatibility: { date: "2026-07-11", flags: ["nodejs_compat"] },
};

export const secretStore = Cloudflare.SecretsStore.Store("integration-secrets");

export type IntegrationCredentials = {
	google: Cloudflare.SecretsStore.Secret;
	github: Cloudflare.SecretsStore.Secret;
};

export default (
	store: Cloudflare.SecretsStore.Store,
	credentials: IntegrationCredentials,
) =>
	Effect.flatMap(Alchemy.Stage, (stage) => {
		const keyring = Effect.flatMap(
			Alchemy.Random("oauth-encryption-primary", { bytes: 32 }),
			(material) =>
				Cloudflare.SecretsStore.Secret("oauth-keyring", {
					store,
					name: `e2-${stage}-integrations-oauth-keyring`,
					value: Output.map(material.text, (value) =>
						Redacted.make(JSON.stringify({
							active: "primary",
							keys: {
								primary: Buffer.from(Redacted.value(value), "hex").toString(
									"base64",
								),
							},
						}))),
				}),
		);
		return Effect.flatMap(keyring, (keyringSecret) =>
			Cloudflare.Worker("integrations-oauth", {
				name: workerName("integrations-oauth", stage),
				...workerSource,
				workersDev: false,
				env: {
					DB: Cloudflare.D1.Database("oauth-db", {
						migrations: fileURLToPath(new URL("./migrations", import.meta.url)),
					}),
					WEBSITE_ORIGIN: Config.string("WEBSITE_DOMAIN").pipe(
						Config.map((domain) =>
							`https://${domain}`
						),
					),
					TOKEN_KEYRING: keyringSecret,
					GOOGLE_CLIENT_ID: Cloudflare.SecretsStore.Secret("google-client-id", {
						store,
						name: `e2-${stage}-google-client-id`,
						value: Config.redacted("GOOGLE_CLIENT_ID"),
					}),
					GOOGLE_CLIENT_SECRET: Cloudflare.SecretsStore.Secret(
						"google-client-secret",
						{
							store,
							name: `e2-${stage}-google-client-secret`,
							value: Config.redacted("GOOGLE_CLIENT_SECRET"),
						},
					),
					GITHUB_CLIENT_ID: Cloudflare.SecretsStore.Secret("github-client-id", {
						store,
						name: `e2-${stage}-github-client-id`,
						value: Config.redacted("GITHUB_CLIENT_ID").pipe(
							Config.withDefault(Redacted.make("")),
						),
					}),
					GITHUB_CLIENT_SECRET: Cloudflare.SecretsStore.Secret(
						"github-client-secret",
						{
							store,
							name: `e2-${stage}-github-client-secret`,
							value: Config.redacted("GITHUB_CLIENT_SECRET").pipe(
								Config.withDefault(Redacted.make("")),
							),
						},
					),
					GOOGLE_SERVICE_CREDENTIAL: credentials.google,
					GITHUB_SERVICE_CREDENTIAL: credentials.github,
					LOCAL_PROVIDER_ORIGIN: Config.string("LOCAL_PROVIDER_ORIGIN").pipe(
						Config.withDefault(""),
					),
				},
				crons: ["17 * * * *"],
			}));
	});
