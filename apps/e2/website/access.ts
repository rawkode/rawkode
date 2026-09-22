import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as ZeroTrust from "@distilled.cloud/cloudflare/zero-trust";

const adminEmails = "david@rawkode.academy";

/** Discover the existing account organization; this never creates or updates it. */
const teamDomain = Effect.flatMap(
	Cloudflare.CloudflareEnvironment,
	(environment) =>
		Effect.flatMap(environment, ({ accountId }) =>
			Effect.flatMap(
				ZeroTrust.listOrganizationsForAccount({ accountId }),
				(organization) => {
					const domain = organization.authDomain;
					return typeof domain === "string" &&
							/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)
						? Effect.succeed(domain)
						: Effect.fail(
							new Error(
								"Enable Cloudflare Zero Trust for the selected account before deploying the website.",
							),
						);
				},
			)),
).pipe(Effect.orDie);

/** Each stage has its own audience and allow policy; enabled account IdPs remain available. */
export const deploymentAccess = Effect.flatMap(
	teamDomain,
	(teamDomain) =>
		Effect.flatMap(
			Alchemy.Stage,
			(stage) =>
				Effect.flatMap(Config.string("WEBSITE_DOMAIN"), (domain) =>
					Effect.map(
						Effect.all({
							application: Cloudflare.Access.Application("website-access", {
								name: `Apsides ${stage}`,
								type: "self_hosted",
								domain,
								sessionDuration: "24h",
								policies: [{
									decision: "allow",
									include: [{ email: adminEmails }],
								}],
							}),
							// A path-specific Access application takes precedence over the
							// hostname-wide application, allowing GitHub to reach the endpoint.
							// The Worker still verifies the exact raw body HMAC before parsing it.
							webhook: Cloudflare.Access.Application("github-webhook-access", {
								name: `Apsides GitHub webhook ${stage}`,
								type: "self_hosted",
								domain: `${domain}/github/webhook`,
								policies: [{
									decision: "bypass",
									include: [{ everyone: {} }],
								}],
							}),
						}),
						({ application }) => ({
							teamDomain,
							audience: application.aud,
							adminEmails,
						}),
					)),
		),
);
