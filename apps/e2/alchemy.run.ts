import documents from "./core/documents/alchemy.ts";
import entities from "./core/entities/alchemy.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import website from "./website/alchemy.ts";
import api from "./api/alchemy.ts";
import { deploymentAccess } from "./website/access.ts";
import oauth, { secretStore } from "./integrations/oauth/alchemy.ts";
import google, {
	serviceCredential as googleCredential,
} from "./integrations/google/alchemy.ts";
import github, {
	serviceCredential as githubCredential,
} from "./integrations/github/alchemy.ts";

export default Alchemy.Stack(
	"e2",
	{ providers: Cloudflare.providers(), state: Cloudflare.state() },
	Effect.Do.pipe(
		Effect.bind("documents", () => documents()),
		Effect.bind("entities", () => entities()),
		Effect.bind("store", () => secretStore),
		Effect.bind("credentials", ({ store }) =>
			Effect.all({
				google: googleCredential(store),
				github: githubCredential(store),
			})),
		Effect.bind("oauth", ({ store, credentials }) => oauth(store, credentials)),
		Effect.bind(
			"integrations",
			({ oauth, credentials, entities, store }) =>
				Effect.all({
					google: google(oauth, credentials.google, entities),
					github: github(oauth, credentials.github, {
						entities,
						store,
					}),
				}),
		),
		Effect.bind("access", () => deploymentAccess),
		Effect.bind(
			"api",
			({ integrations, access, documents, entities }) =>
				api(
					integrations.google,
					integrations.github,
					documents,
					entities,
					access,
				),
		),
		Effect.bind(
			"website",
			({ oauth, integrations, api, access, documents }) =>
				website(
					oauth,
					integrations.google,
					integrations.github,
					api,
					documents,
					access,
				),
		),
		Effect.map((
			{ oauth, integrations, website, api, documents, entities },
		) => ({
			documents: documents.workerName,
			entities: entities.workerName,
			website: website.url,
			api: api.workerName,
			oauth: oauth.workerName,
			google: integrations.google.workerName,
			github: integrations.github.workerName,
		})),
	),
);
