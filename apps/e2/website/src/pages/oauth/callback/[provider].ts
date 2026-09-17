import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";

export const GET: APIRoute = ({ request, params }) => {
	if (!["google", "github"].includes(params.provider ?? "")) {
		return new Response("Not found", { status: 404 });
	}
	const headers = new Headers();
	const cookie = request.headers.get("Cookie");
	if (cookie) headers.set("Cookie", cookie);
	return bindings.OAUTH.fetch(
		new Request(request.url, { headers, redirect: "manual" }),
	);
};
