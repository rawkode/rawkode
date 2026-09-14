import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";
import type { Identity } from "../../../lib/auth.ts";

export const POST: APIRoute = async ({ locals, redirect }) => {
	try {
		const identity = (locals as { admin: Identity }).admin;
		using github = await bindings.GITHUB_ADMIN.admin(identity.ownerId);
		const installation = await github.beginAppInstallation();
		return redirect(installation.url, 303);
	} catch {
		return redirect("/admin/oauth?result=github-app-failed", 303);
	}
};
