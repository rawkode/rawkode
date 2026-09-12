import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";
import { readForm, requiredField } from "../../../lib/forms.ts";

export const POST: APIRoute = async ({ request, locals, redirect }) => {
	try {
		const form = await readForm(request);
		const connectionId = requiredField(form, "connectionId");
		const action = requiredField(form, "action");
		using oauth = await bindings.OAUTH_ADMIN.admin(locals.admin.ownerId);
		const account = (await oauth.listConnections()).find((entry) =>
			entry.id === connectionId
		);
		if (!account) return new Response("Account not found", { status: 404 });
		if (action === "sync" && account.providerId === "google") {
			await oauth.grantService(connectionId, "integrations-google");
			using google = await bindings.GOOGLE_ADMIN.admin(locals.admin.ownerId);
			await google.syncGoogle(connectionId);
			return redirect("/admin/oauth?result=syncing", 303);
		}
		if (action === "disable-sync" && account.providerId === "google") {
			await oauth.revokeService(connectionId, "integrations-google");
			return redirect("/admin/oauth?result=sync-disabled", 303);
		}
		if (action === "enable-github" && account.providerId === "github") {
			await oauth.grantService(connectionId, "integrations-github");
			return redirect("/admin/oauth?result=github-enabled", 303);
		}
		if (action === "disable-github" && account.providerId === "github") {
			await oauth.revokeService(connectionId, "integrations-github");
			return redirect("/admin/oauth?result=github-disabled", 303);
		}
		if (action === "delete") {
			if (account.providerId === "google") {
				using google = await bindings.GOOGLE_ADMIN.admin(locals.admin.ownerId);
				await google.deleteAccount(connectionId);
			}
			await oauth.disconnect(connectionId);
			return redirect("/admin/oauth?result=deleted", 303);
		}
		return new Response("Invalid action", { status: 400 });
	} catch {
		return redirect("/admin/oauth?result=action-failed", 303);
	}
};
