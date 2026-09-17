import { newHttpBatchRpcSession } from "capnweb";
import type { OAuthAdminApi, OAuthIntegrationApi } from "./contracts";
export type * from "./contracts";

export const createOAuthAdminClient = (url = "/api/oauth/rpc") => newHttpBatchRpcSession<OAuthAdminApi>(url);

/** Cloudflare native RPC and Cap'n Web share RpcTarget capabilities. */
export interface OAuthIntegrationBinding {
  authorize(credential: string): Promise<OAuthIntegrationApi & Disposable>;
}

export interface OAuthAdminBinding {
  fetch(request: Request): Promise<Response>;
  admin(ownerId: string): Promise<OAuthAdminApi & Disposable>;
}

export function connectOAuth(binding: OAuthIntegrationBinding, credential: string) {
  return binding.authorize(credential);
}
