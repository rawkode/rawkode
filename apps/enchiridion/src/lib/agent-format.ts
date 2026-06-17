import type { MiniAppIntent } from "./mini-app-requests";

export function formatMiniAppResult(result: Record<string, unknown>, intent: MiniAppIntent, origin?: string): string {
	const status = String(result.status ?? "completed");
	const operation = String(result.operation ?? intent.operation);
	const slug = String(result.slug ?? intent.targetSlug ?? "mini-app");
	const message = typeof result.message === "string" ? result.message : "";
	const routeUrl = typeof result.routeUrl === "string" ? result.routeUrl : "";
	const issues = Array.isArray(result.issues) ? result.issues.map(String) : [];

	if (issues.length > 0) {
		return `${status}: ${slug}. ${issues.join(" ")}`.trim();
	}

	if (status === "validation_failed") {
		const details = message || "The Worker uploaded, but the primary route did not render.";
		return `${status}: ${slug}. Candidate Worker failed smoke testing and was not activated. ${details}`.trim();
	}

	if (status.startsWith("fallback_")) {
		const details = message || "Static fallback mini app could not be activated.";
		return `${status}: ${slug}. Fallback mini app was not activated. ${details}`.trim();
	}

	if (result.deployed === true) {
		const route = routeUrl ? ` ${formatRouteUrl(routeUrl, origin)}` : "";
		if (result.fallback === true) {
			const details = message || "LLM generation failed; deployed a static fallback mini app.";
			return `${status}: ${slug} fallback deployed.${route} ${details}`.trim();
		}

		return `${status}: ${slug} ${operation === "update" ? "updated" : "deployed"}.${route}`.trim();
	}

	return `${status}: ${slug}. ${message}`.trim();
}

export function formatAgentResult(result: unknown): string {
	if (!result) {
		return "Done.";
	}
	if (typeof result === "string") {
		return result;
	}
	if (typeof result === "object") {
		const text = readAgentText(result);
		if (text) {
			return text;
		}
		try {
			return JSON.stringify(result);
		} catch {
			return "Done.";
		}
	}

	return String(result);
}

export function formatAgentError(error: unknown, fallback: string): string {
	if (!error) {
		return fallback;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error instanceof Error) {
		return error.message || fallback;
	}
	if (typeof error === "object") {
		const message = readStringProperty(error, "message") ?? readStringProperty(error, "error");
		if (message) {
			return message;
		}

		try {
			return JSON.stringify(error);
		} catch {
			return fallback;
		}
	}

	return String(error);
}

function formatRouteUrl(routeUrl: string, origin?: string): string {
	if (routeUrl.startsWith("/") && origin) {
		return `${origin}${routeUrl}`;
	}

	return routeUrl;
}

function readAgentText(source: unknown, depth = 0): string | undefined {
	if (depth > 4 || !source) {
		return undefined;
	}
	if (typeof source === "string") {
		return source;
	}
	if (Array.isArray(source)) {
		const parts = source
			.map((entry) => readAgentText(entry, depth + 1))
			.filter((entry): entry is string => Boolean(entry));
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (typeof source !== "object") {
		return undefined;
	}

	const text = readStringProperty(source, "text")
		?? readStringProperty(source, "message")
		?? readStringProperty(source, "content");
	if (text) {
		return text;
	}

	for (const key of ["result", "response", "output", "data", "content"]) {
		if (key in source) {
			const nested = readAgentText((source as Record<string, unknown>)[key], depth + 1);
			if (nested) {
				return nested;
			}
		}
	}

	return undefined;
}

function readStringProperty(source: object, key: string): string | undefined {
	if (!(key in source)) {
		return undefined;
	}
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
