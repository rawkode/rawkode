import { createHash } from "node:crypto";

export const requiredWorkerSecretNames = [
	"CLOUDFLARE_API_TOKEN",
	"ENCHIRIDION_PASSWORD",
	"HOST_SIGNING_SECRET",
];

export function deriveHostSigningSecret(seed) {
	return createHash("sha256")
		.update(`enchiridion-host-context-v1:${seed}`)
		.digest("hex");
}

export function buildWorkerSecretPayload(env) {
	const cloudflareToken = env.CLOUDFLARE_API_TOKEN;
	const appPassword = env.ENCHIRIDION_PASSWORD;
	const hostSigningSeed = env.HOST_SIGNING_SECRET;
	const missing = [];

	if (!cloudflareToken) {
		missing.push("CLOUDFLARE_API_TOKEN");
	}
	if (!appPassword) {
		missing.push("ENCHIRIDION_PASSWORD");
	}
	if (!hostSigningSeed) {
		missing.push("HOST_SIGNING_SECRET");
	}
	if (missing.length > 0) {
		throw new Error(`${missing.join(", ")} required to sync Enchiridion Worker secrets.`);
	}

	return {
		CLOUDFLARE_API_TOKEN: cloudflareToken,
		ENCHIRIDION_PASSWORD: appPassword,
		HOST_SIGNING_SECRET: deriveHostSigningSecret(hostSigningSeed),
	};
}
