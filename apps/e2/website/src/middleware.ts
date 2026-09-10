import { defineMiddleware } from "astro:middleware";
import { authenticate, sameOriginPost } from "./lib/auth.ts";
import { bindings } from "./lib/env.ts";

export const onRequest = defineMiddleware(async (context, next) => {
	const callback = /^\/oauth\/callback\/(google|github)$/.test(
		context.url.pathname,
	);
	if (context.url.origin !== bindings.WEBSITE_ORIGIN) {
		return new Response("Unknown website origin.", { status: 400 });
	}
	if (!callback) {
		const identity = await authenticate(context.request, bindings);
		if (!identity) {
			return new Response(
				"Sign in through Cloudflare Access to open Apsides.",
				{
					status: 401,
					headers: { "Cache-Control": "no-store" },
				},
			);
		}
		context.locals.admin = identity;
		if (
			!["GET", "HEAD"].includes(context.request.method) &&
			!sameOriginPost(context.request, bindings.WEBSITE_ORIGIN)
		) return new Response("Request origin is not allowed.", { status: 403 });
	}
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const upstream = await next();
	const response = new Response(upstream.body, upstream);
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("X-Content-Type-Options", "nosniff");
	response.headers.set(
		"Referrer-Policy",
		callback ? "no-referrer" : "same-origin",
	);
	response.headers.set("X-Frame-Options", "DENY");
	response.headers.set(
		"Content-Security-Policy",
		`default-src 'self'; script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src 'self' https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://accounts.google.com https://github.com`,
	);
	if (response.headers.get("Content-Type")?.includes("text/html")) {
		return new HTMLRewriter().on("script", {
			element: (element) => {
				element.setAttribute("nonce", nonce);
			},
		}).transform(response);
	}
	return response;
});
