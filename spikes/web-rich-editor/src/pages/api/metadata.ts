import type { APIRoute } from "astro";
import { resolveMetadata } from "../../server/metadata";
import { json, readJSON } from "../../server/request";
import { z } from "zod";
import { safeURL, linkMetadataSchema } from "../../lib/note";

const metadataRequestSchema = z.strictObject({
	url: z
		.string()
		.max(4096)
		.transform((value) => safeURL(value)),
});

export const POST: APIRoute = async ({ request, url }) => {
	try {
		const body = metadataRequestSchema.parse(
			await readJSON(request, url.origin),
		);
		return json(linkMetadataSchema.parse(await resolveMetadata(body.url)));
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
