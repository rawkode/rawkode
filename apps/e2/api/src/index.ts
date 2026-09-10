import { execute, parse, validate } from "graphql";
import { authenticate } from "../../website/src/lib/auth.ts";
import { integrations } from "../integrations.ts";
import { type ApiEnv, createContext } from "./context.ts";
import { composeSchema } from "./schema.ts";
import { enforceQueryBudget } from "./limits.ts";

const { schema, fieldResolver } = composeSchema(integrations);
const response = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
const readRequest = async (request: Request) => {
	if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
		throw new Error("Use application/json.");
	}
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Request body required.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 32768) {
				await reader.cancel();
				throw new Error("Request body exceeds 32 KiB.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("Expected a GraphQL request.");
	}
	const { query, variables, operationName } = body as Record<string, unknown>;
	if (typeof query !== "string" || !query || query.length > 16384) {
		throw new Error("Query must contain at most 16 KiB.");
	}
	if (
		variables !== undefined &&
		(variables === null || typeof variables !== "object" ||
			Array.isArray(variables))
	) throw new Error("Variables must be an object.");
	if (operationName !== undefined && typeof operationName !== "string") {
		throw new Error("Invalid operation name.");
	}
	return {
		query,
		variables: variables as Record<string, unknown> | undefined,
		operationName,
	};
};

export const fetchApi = async (
	request: Request,
	env: ApiEnv,
): Promise<Response> => {
	const path = new URL(request.url).pathname;
	if (path === "/health" && request.method === "GET") {
		return response({ service: "api", status: "ok" });
	}
	if (path !== "/api/graphql") {
		return new Response("Not found", { status: 404 });
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}
	const identity = await authenticate(request, env);
	if (!identity) {
		return response({ errors: [{ message: "Unauthorized." }] }, 401);
	}
	try {
		const body = await readRequest(request);
		const document = parse(body.query, { maxTokens: 2000 });
		const errors = validate(schema, document, undefined, { maxErrors: 10 });
		if (errors.length) {
			return response({
				errors: errors.map((error) => ({ message: error.message })),
			}, 400);
		}
		enforceQueryBudget(document, body.operationName);
		const result = await execute({
			schema,
			document,
			fieldResolver,
			contextValue: createContext(env, identity),
			variableValues: body.variables,
			operationName: body.operationName,
		});
		return response({
			...result,
			...(result.errors
				? {
					errors: result.errors.map(() => ({
						message: "The integration could not complete this query.",
					})),
				}
				: {}),
		});
	} catch {
		return response({
			errors: [{ message: "Invalid GraphQL request or query limit exceeded." }],
		}, 400);
	}
};

export default { fetch: fetchApi } satisfies ExportedHandler<ApiEnv>;
