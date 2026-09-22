import { newHttpBatchRpcSession } from "capnweb";
import type { OAuthAdminApi, OAuthIntegrationApi } from "./contracts.ts";
export type * from "./contracts.ts";

export const createOAuthAdminClient = (url = "/api/oauth/rpc") =>
	newHttpBatchRpcSession<OAuthAdminApi>(url);

/** Cloudflare native RPC and Cap'n Web share RpcTarget capabilities. */
export interface OAuthIntegrationBinding {
	authorize(credential: string): Promise<OAuthIntegrationApi & Disposable>;
}

export interface OAuthAdminBinding {
	fetch(request: Request): Promise<Response>;
	admin(ownerId: string): Promise<OAuthAdminApi & Disposable>;
}

export interface SecretBinding {
	get(): Promise<string>;
}

export const connectOAuth = async (
	binding: OAuthIntegrationBinding,
	credential: SecretBinding,
): Promise<OAuthIntegrationApi & Disposable> => {
	return binding.authorize(await credential.get());
};
