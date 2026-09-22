import { newWorkersRpcResponse } from "capnweb";
import type { OAuthEnv } from "./env.ts";
import { AdminApi } from "./admin.ts";
import { authenticateService, IntegrationApi } from "./tokens.ts";
import { safeCall } from "./errors.ts";

export const adminResponse = (request: Request, env: OAuthEnv) => {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	const owner = request.headers.get("X-E2-Owner");
	if (!owner) return new Response("Unauthorized", { status: 401 });
	return newWorkersRpcResponse(request, new AdminApi(env, owner));
};

export const authorizeIntegration = (env: OAuthEnv, credential: string) =>
	safeCall(async () => {
		await authenticateService(env, credential);
		return new IntegrationApi(env, credential);
	});

export const integrationResponse = async (request: Request, env: OAuthEnv) => {
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	const credential =
		request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
	try {
		await authenticateService(env, credential);
	} catch {
		return new Response("Unauthorized", { status: 401 });
	}
	return newWorkersRpcResponse(request, new IntegrationApi(env, credential));
};
