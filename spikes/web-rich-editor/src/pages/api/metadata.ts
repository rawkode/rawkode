import type { APIRoute } from "astro";
import { resolveMetadata } from "../../server/metadata";
import { json, readJSON } from "../../server/request";

export const POST: APIRoute = async ({ request, url }) => {
	try {
		const body = (await readJSON(request, url.origin)) as { url?: unknown };
		if (typeof body.url !== "string" || body.url.length > 4096)
			throw new Error("Enter a valid web URL.");
		return json(await resolveMetadata(body.url));
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error ? error.message : "Could not load metadata.",
			},
			400,
		);
	}
};
