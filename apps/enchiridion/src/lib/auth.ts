import type { Env, Principal } from "./types";

export function authenticate(request: Request, env: Env): Principal | null {
	const email = request.headers.get("cf-access-authenticated-user-email");
	const name = request.headers.get("cf-access-authenticated-user-name") ?? email;

	if (email && shouldTrustCloudflareAccessHeaders(env) && isAllowedEmail(email, env.ALLOWED_EMAILS)) {
		return { email, name: name ?? email, source: "cloudflare-access" };
	}

	const passwordPrincipal = authenticateWithPassword(request, env.ENCHIRIDION_PASSWORD);
	if (passwordPrincipal) {
		return passwordPrincipal;
	}

	if (isLocalDevelopmentRequest(request)) {
		const devEmail = env.DEV_USER_EMAIL ?? "rawkode.local";
		return {
			email: devEmail,
			name: devEmail,
			source: "dev",
		};
	}

	return null;
}

export function requirePrincipal(request: Request, env: Env): Principal {
	const principal = authenticate(request, env);

	if (!principal) {
		throw unauthorizedResponse();
	}

	return principal;
}

export function unauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: "Unauthorized" }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"www-authenticate": 'Basic realm="Enchiridion", charset="UTF-8"',
		},
	});
}

function shouldTrustCloudflareAccessHeaders(env: Env): boolean {
	return env.TRUST_CLOUDFLARE_ACCESS_HEADERS === "true";
}

function isAllowedEmail(email: string, allowedEmails?: string): boolean {
	if (!allowedEmails || allowedEmails.trim() === "") {
		return false;
	}

	const allowed = allowedEmails.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(email.toLowerCase());
}

function authenticateWithPassword(request: Request, password?: string): Principal | null {
	if (!password) {
		return null;
	}

	const credentials = readBasicAuth(request.headers.get("authorization"));
	if (!credentials || !passwordMatches(credentials.password, password)) {
		return null;
	}

	const name = credentials.username || "enchiridion";
	return {
		email: `${name}@password.enchiridion.local`,
		name,
		source: "password",
	};
}

function readBasicAuth(header: string | null): { username: string; password: string } | null {
	if (!header?.toLowerCase().startsWith("basic ")) {
		return null;
	}

	try {
		const decoded = atob(header.slice("basic ".length).trim());
		const separator = decoded.indexOf(":");
		if (separator < 0) {
			return null;
		}

		return {
			username: decoded.slice(0, separator),
			password: decoded.slice(separator + 1),
		};
	} catch {
		return null;
	}
}

function passwordMatches(candidate: string, password: string): boolean {
	const candidateBytes = new TextEncoder().encode(candidate);
	const passwordBytes = new TextEncoder().encode(password);
	const comparisonLength = Math.max(candidateBytes.length, passwordBytes.length, 256);

	let mismatch = candidateBytes.length ^ passwordBytes.length;
	for (let index = 0; index < comparisonLength; index += 1) {
		mismatch |= (candidateBytes[index] ?? 0) ^ (passwordBytes[index] ?? 0);
	}

	return mismatch === 0;
}

function isLocalDevelopmentRequest(request: Request): boolean {
	const { hostname } = new URL(request.url);
	return hostname === "localhost"
		|| hostname === "127.0.0.1"
		|| hostname === "::1"
		|| hostname === "[::1]"
		|| hostname.endsWith(".localhost");
}
