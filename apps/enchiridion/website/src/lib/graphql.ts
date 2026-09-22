import { bindings } from "./env.ts";

export const apiHeaders = (request: Request): Headers => {
	const headers = new Headers({ "Content-Type": "application/json" });
	const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
	if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
	return headers;
};

export const queryApi = async <T>(
	request: Request,
	query: string,
	variables: Record<string, string> = {},
): Promise<T> => {
	const response = await bindings.API.fetch(
		new Request(new URL("/api/graphql", request.url), {
			method: "POST",
			headers: apiHeaders(request),
			body: JSON.stringify({ query, variables }),
		}),
	);
	if (!response.ok) throw new Error("Account data is unavailable");
	const result = await response.json() as { data?: T; errors?: unknown[] };
	if (result.errors?.length || !result.data) {
		throw new Error("Account data is unavailable");
	}
	return result.data;
};
