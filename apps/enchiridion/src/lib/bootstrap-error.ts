export function formatBootstrapLoadError(error: unknown): string {
	const message = readErrorMessage(error).trim();
	if (!message) {
		return "Enchiridion could not load its startup data.";
	}
	if (/^Failed to fetch\.?$/i.test(message)) {
		return "The app shell could not reach the Enchiridion API.";
	}
	return message;
}

function readErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return String(error ?? "");
}
