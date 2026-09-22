import * as oauth from "oauth4webapi";

const errorCodes = new Set([
	"ERR_INVALID_ARG_TYPE",
	"ERR_INVALID_ARG_VALUE",
	oauth.WWW_AUTHENTICATE_CHALLENGE,
	oauth.RESPONSE_BODY_ERROR,
	oauth.UNSUPPORTED_OPERATION,
	oauth.AUTHORIZATION_RESPONSE_ERROR,
	oauth.PARSE_ERROR,
	oauth.INVALID_RESPONSE,
	oauth.INVALID_REQUEST,
	oauth.RESPONSE_IS_NOT_JSON,
	oauth.RESPONSE_IS_NOT_CONFORM,
	oauth.HTTP_REQUEST_FORBIDDEN,
	oauth.REQUEST_PROTOCOL_FORBIDDEN,
	oauth.JWT_TIMESTAMP_CHECK,
	oauth.JWT_CLAIM_COMPARISON,
	oauth.JSON_ATTRIBUTE_COMPARISON,
	oauth.KEY_SELECTION,
	oauth.MISSING_SERVER_METADATA,
	oauth.INVALID_SERVER_METADATA,
]);
const providerErrors = new Set([
	"access_denied",
	"invalid_request",
	"invalid_client",
	"invalid_grant",
	"unauthorized_client",
	"unsupported_grant_type",
	"unsupported_response_type",
	"invalid_scope",
	"server_error",
	"temporarily_unavailable",
	"bad_verification_code",
	"incorrect_client_credentials",
	"redirect_uri_mismatch",
]);
const errorTypes = new Set([
	"Error",
	"TypeError",
	"SyntaxError",
	"RangeError",
	"AbortError",
	"TimeoutError",
	"OperationError",
	"OperationProcessingError",
	"ResponseBodyError",
	"AuthorizationResponseError",
	"UnsupportedOperationError",
]);

/** Never log messages, causes, response bodies, or arbitrary provider strings. */
export const failureDetails = (
	error: unknown,
	responseStatus?: number,
): Record<string, unknown> => {
	const details: Record<string, unknown> = {
		type: error instanceof Error && errorTypes.has(error.name)
			? error.name
			: "UnknownError",
	};
	if (
		error instanceof Error && "code" in error &&
		typeof error.code === "string" && errorCodes.has(error.code)
	) {
		details.code = error.code;
	}
	if (
		error instanceof oauth.ResponseBodyError ||
		error instanceof oauth.AuthorizationResponseError
	) {
		if (providerErrors.has(error.error)) details.providerError = error.error;
		if (error instanceof oauth.ResponseBodyError) responseStatus = error.status;
	}
	if (
		Number.isInteger(responseStatus) && responseStatus! >= 100 &&
		responseStatus! <= 599
	) {
		details.status = responseStatus;
	}
	return details;
};
