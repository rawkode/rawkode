import type { APIRoute } from "astro";
import { bindings } from "../../lib/env.ts";
import type { Identity } from "../../lib/auth.ts";

export const GET: APIRoute = async ({ url, locals, redirect }) => {
	const state = url.searchParams.get("state") ?? "";
	const installationId = url.searchParams.get("installation_id") ?? "";
	try {
		const identity = (locals as { admin: Identity }).admin;
		using github = await bindings.GITHUB_ADMIN.admin(identity.ownerId);
		await github.completeAppInstallation(state, installationId);
		return redirect("/admin/oauth?result=github-app-installed", 303);
	} catch {
		return redirect("/admin/oauth?result=github-app-failed", 303);
	}
};
