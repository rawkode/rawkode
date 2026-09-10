export class OAuthError extends Error {}

export const safeCall = async <T>(action: () => T | Promise<T>): Promise<T> => {
	try {
		return await action();
	} catch (error) {
		if (error instanceof OAuthError) throw error;
		if (error instanceof Error) {
			console.error("OAuth operation failed", {
				type: error.name,
				location: error.stack?.split("\n").slice(1, 4).join("\n"),
			});
		}
		// Provider responses and database errors can contain credentials. Never serialize them over RPC.
		throw new OAuthError(
			"The OAuth service could not complete the request. Please try again.",
		);
	}
};

export const requireString = (
	value: unknown,
	name: string,
	max = 200,
): string => {
	if (
		typeof value !== "string" || !value.trim() || value.length > max ||
		[...value].some((character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		)
	) {
		throw new OAuthError(`Enter a valid ${name}.`);
	}
	return value.trim();
};

export const requireScopes = (value: unknown): string[] => {
	if (!Array.isArray(value) || value.length === 0 || value.length > 40) {
		throw new OAuthError("Choose at least one scope (maximum 40).");
	}
	return [...new Set(value.map((scope) => requireString(scope, "scope", 200)))]
		.sort();
};
