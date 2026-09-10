import type { SecretBinding } from "@e2/oauth-client";
export interface OAuthEnv {
	DB: D1Database;
	WEBSITE_ORIGIN: string;
	GOOGLE_CLIENT_ID?: SecretBinding;
	GOOGLE_CLIENT_SECRET?: SecretBinding;
	GITHUB_CLIENT_ID?: SecretBinding;
	GITHUB_CLIENT_SECRET?: SecretBinding;
	TOKEN_KEYRING: SecretBinding;
	GOOGLE_SERVICE_CREDENTIAL: SecretBinding;
	GITHUB_SERVICE_CREDENTIAL: SecretBinding;
	/** Test-only, accepted exclusively with HTTP loopback origins. */
	LOCAL_PROVIDER_ORIGIN?: string;
}

export const websiteOrigin = (env: OAuthEnv): string => {
	const url = new URL(env.WEBSITE_ORIGIN);
	const local = url.protocol === "http:" &&
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(!local && url.protocol !== "https:") || url.origin !== env.WEBSITE_ORIGIN
	) {
		throw new Error(
			"WEBSITE_ORIGIN must be an HTTPS origin (HTTP loopback is allowed locally).",
		);
	}
	return url.origin;
};

export const serviceCredentials = (
	env: OAuthEnv,
): Record<string, SecretBinding> => ({
	"integrations-google": env.GOOGLE_SERVICE_CREDENTIAL,
	"integrations-github": env.GITHUB_SERVICE_CREDENTIAL,
});
