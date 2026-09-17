import type { APIRoute } from "astro";
import { bindings } from "../../lib/env.ts";
import { apiHeaders } from "../../lib/graphql.ts";

export const POST: APIRoute = ({ request }) => {
	if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
		return new Response("Expected JSON", { status: 415 });
	}
	return bindings.API.fetch(
		new Request(request.url, {
			method: "POST",
			headers: apiHeaders(request),
			body: request.body,
		}),
	);
};
