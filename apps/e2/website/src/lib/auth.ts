import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthConfig {
	WEBSITE_ORIGIN: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUDIENCE: string;
	ADMIN_EMAILS: string;
}

export interface Identity {
	ownerId: string;
	email: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const authenticate = async (
	request: Request,
	config: AuthConfig,
): Promise<Identity | null> => {
	if (new URL(request.url).origin !== config.WEBSITE_ORIGIN) return null;
	if (
		!config.ACCESS_TEAM_DOMAIN ||
		!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.ACCESS_TEAM_DOMAIN) ||
		!config.ACCESS_AUDIENCE || !config.ADMIN_EMAILS
	) return null;
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!assertion) return null;
	const issuer = `https://${config.ACCESS_TEAM_DOMAIN}`;
	const keys = keySets.get(issuer) ?? createRemoteJWKSet(
		new URL(`${issuer}/cdn-cgi/access/certs`),
		{ timeoutDuration: 5000 },
	);
	keySets.set(issuer, keys);
	try {
		const { payload } = await jwtVerify(assertion, keys, {
			issuer,
			audience: config.ACCESS_AUDIENCE,
			algorithms: ["RS256"],
			requiredClaims: ["sub", "email", "exp", "iat"],
		});
		const allowed = config.ADMIN_EMAILS.split(",").map((email) =>
			email.trim().toLowerCase()
		);
		if (
			typeof payload.email !== "string" || typeof payload.sub !== "string" ||
			!payload.sub || payload.sub.length > 190 ||
			!allowed.includes(payload.email.toLowerCase())
		) return null;
		return { ownerId: `access:${payload.sub}`, email: payload.email };
	} catch {
		return null;
	}
};

export const sameOriginPost = (request: Request, origin: string): boolean =>
	request.method === "POST" && new URL(request.url).origin === origin &&
	request.headers.get("Origin") === origin &&
	!["cross-site", "none"].includes(request.headers.get("Sec-Fetch-Site") ?? "");
