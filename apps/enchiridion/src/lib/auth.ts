import type { Env, Principal } from "./types";

export function authenticate(request: Request, env: Env): Principal | null {
	const email = request.headers.get("cf-access-authenticated-user-email");
	const name = request.headers.get("cf-access-authenticated-user-name") ?? email;

	if (email && isAllowedEmail(email, env.ALLOWED_EMAILS)) {
		return { email, name: name ?? email, source: "cloudflare-access" };
	}

	if (env.DEV_USER_EMAIL) {
		return {
			email: env.DEV_USER_EMAIL,
			name: env.DEV_USER_EMAIL,
			source: "dev",
		};
	}

	return null;
}

export function requirePrincipal(request: Request, env: Env): Principal {
	const principal = authenticate(request, env);

	if (!principal) {
		throw new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}

	return principal;
}

function isAllowedEmail(email: string, allowedEmails?: string): boolean {
	if (!allowedEmails || allowedEmails.trim() === "") {
		return true;
	}

	const allowed = allowedEmails.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	return allowed.includes(email.toLowerCase());
}
