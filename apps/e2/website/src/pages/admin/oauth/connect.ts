import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";
import { readForm, requiredField } from "../../../lib/forms.ts";

export const POST: APIRoute = async (
	{ request, locals, cookies, redirect },
) => {
	try {
		const appId = requiredField(await readForm(request), "appId");
		const binding = btoa(
			String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
		)
			.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding)),
		);
		const browserBindingHash = Array.from(
			digest,
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		using api = await bindings.OAUTH_ADMIN.admin(locals.admin.ownerId);
		const flow = await api.beginConnection({ appId, browserBindingHash });
		const secure = bindings.WEBSITE_ORIGIN.startsWith("https:");
		cookies.set(
			`${secure ? "__Host-" : ""}e2-oauth-${flow.stateId.slice(0, 24)}`,
			binding,
			{
				httpOnly: true,
				sameSite: "lax",
				path: "/",
				secure,
				maxAge: 600,
			},
		);
		return redirect(flow.authorizationUrl, 303);
	} catch {
		return redirect("/admin/oauth?result=failed", 303);
	}
};
