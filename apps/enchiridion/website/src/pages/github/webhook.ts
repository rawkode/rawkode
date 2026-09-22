import type { APIRoute } from "astro";
import { bindings } from "../../lib/env.ts";

export const POST: APIRoute = ({ request }) => {
	const upstream = new URL(request.url);
	upstream.pathname = "/github/webhook";
	return bindings.GITHUB.fetch(new Request(upstream, request));
};

export const ALL: APIRoute = () =>
	new Response("Method not allowed", { status: 405 });
