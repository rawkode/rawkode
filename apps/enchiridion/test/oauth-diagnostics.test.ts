import { strict as assert } from "node:assert";
import * as oauth from "oauth4webapi";
import { failureDetails } from "../integrations/oauth/src/diagnostics.ts";

Deno.test("OAuth diagnostics retain known error codes and HTTP status without sensitive details", () => {
	const error = Object.assign(
		new TypeError("token=secret-client-value", {
			cause: { authorization: "Bearer private-access-token" },
		}),
		{ code: "ERR_INVALID_ARG_TYPE" },
	);
	assert.deepEqual(failureDetails(error, 200), {
		type: "TypeError",
		code: "ERR_INVALID_ARG_TYPE",
		status: 200,
	});
	assert.equal(JSON.stringify(failureDetails(error)).includes("secret"), false);
});

Deno.test("OAuth diagnostics drop arbitrary codes, names, payloads, and invalid status", () => {
	const error = Object.assign(new Error("private"), {
		name: "private-name",
		code: "private-code",
		error: "private-provider-value",
	});
	assert.deepEqual(failureDetails(error, 123456), { type: "UnknownError" });
	assert.deepEqual(failureDetails({ token: "private" }), {
		type: "UnknownError",
	});
	assert.deepEqual(failureDetails(error, NaN), { type: "UnknownError" });
});

Deno.test("OAuth diagnostics allow known provider errors but exclude untrusted provider content", () => {
	const response = new Response(null, { status: 400 });
	const known = new oauth.ResponseBodyError("private-message", {
		response,
		cause: { error: "invalid_grant", error_description: "private-description" },
	});
	assert.deepEqual(failureDetails(known), {
		type: "ResponseBodyError",
		code: oauth.RESPONSE_BODY_ERROR,
		providerError: "invalid_grant",
		status: 400,
	});
	const unknown = new oauth.ResponseBodyError("private-message", {
		response,
		cause: { error: "private-token-value" },
	});
	assert.deepEqual(failureDetails(unknown), {
		type: "ResponseBodyError",
		code: oauth.RESPONSE_BODY_ERROR,
		status: 400,
	});
});
