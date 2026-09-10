import type { OAuthIntegrationBinding, SecretBinding } from "@e2/oauth-client";

export interface GitHubEnv {
	OAUTH: OAuthIntegrationBinding;
	OAUTH_SERVICE_CREDENTIAL: SecretBinding;
}
