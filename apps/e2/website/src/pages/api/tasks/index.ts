import type { APIRoute } from "astro";
import { bindings } from "../../../lib/env.ts";
import { handleTasksRequest } from "../../../lib/tasks.ts";
const route: APIRoute = async ({ request, locals }) => {
	using entities = await bindings.ENTITIES_ADMIN.admin(locals.admin.ownerId);
	return await handleTasksRequest(request, entities, locals.admin.ownerId);
};
export const GET = route;
export const POST = route;
