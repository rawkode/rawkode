import type { OAuthIntegrationBinding, SecretBinding } from "@e2/oauth-client";
import type { EntitiesApi } from "@e2/entities";

export interface GitHubInstallationStub extends Rpc.DurableObjectBranded {
	claim(input: InstallationIdentity): Promise<void>;
	start(): Promise<void>;
	receiveWebhook(
		deliveryId: string,
		event: string,
		payload: Record<string, unknown>,
	): Promise<{ duplicate: boolean }>;
}

export interface InstallationIdentity {
	installationId: string;
	ownerId: string;
	accountId: string;
	accountLogin: string;
	targetType: "User" | "Organization";
}

export interface EntitiesAdminBinding {
	admin(ownerId: string): Promise<EntitiesApi & Disposable>;
}

export interface GitHubEnv {
	OAUTH: OAuthIntegrationBinding;
	OAUTH_SERVICE_CREDENTIAL: SecretBinding;
	DB?: D1Database;
	GITHUB_INSTALLATIONS?: DurableObjectNamespace<GitHubInstallationStub>;
	ENTITIES_ADMIN?: EntitiesAdminBinding;
	GITHUB_APP_ID?: string;
	GITHUB_APP_SLUG?: string;
	GITHUB_APP_PRIVATE_KEY?: SecretBinding;
	GITHUB_WEBHOOK_SECRET?: SecretBinding;
	/** Test-only and accepted exclusively for an HTTP loopback origin. */
	GITHUB_API_ORIGIN?: string;
}
