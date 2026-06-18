import type { MiniAppIntent } from "./mini-app-requests";

export function formatMiniAppResult(result: Record<string, unknown>, intent: MiniAppIntent, origin?: string): string {
	const status = String(result.status ?? "completed");
	const operation = String(result.operation ?? intent.operation);
	const slug = String(result.slug ?? intent.targetSlug ?? "mini-app");
	const message = typeof result.message === "string" ? result.message : "";
	const routeUrl = typeof result.routeUrl === "string" ? result.routeUrl : "";
	const issues = Array.isArray(result.issues) ? result.issues.map(formatUnknown).filter(Boolean) : [];
	const attemptSummary = formatAttemptSummary(result.attempts);

	if (issues.length > 0) {
		return `${status}: ${slug}. ${joinParts([issues.join(" "), attemptSummary])}`.trim();
	}

	if (status === "validation_failed") {
		const details = message || "The Worker uploaded, but a worker-page route did not render.";
		return `${status}: ${slug}. Candidate Worker failed smoke testing and was not activated. ${joinParts([details, attemptSummary])}`.trim();
	}

	if (status.startsWith("fallback_")) {
		const details = message || "Static fallback mini app could not be activated.";
		return `${status}: ${slug}. Fallback mini app was not activated. ${joinParts([details, attemptSummary])}`.trim();
	}

	if (status === "update_deferred") {
		const route = routeUrl ? ` ${formatRouteUrl(routeUrl, origin)}` : "";
		const details = message || "Update candidate was not activated; the active route was left unchanged.";
		return `${status}: ${slug} update candidate was not activated; active route preserved.${route} ${joinParts([details, attemptSummary])}`.trim();
	}

	if (status.endsWith("_pending")) {
		const route = routeUrl ? ` ${formatRouteUrl(routeUrl, origin)}` : "";
		const subject = result.fallback === true ? "fallback route" : "route";
		const details = message || "Worker uploaded and registered, but dispatch validation has not passed yet.";
		return `${status}: ${slug} ${subject} registered pending dispatch validation.${route} ${joinParts([details, attemptSummary])}`.trim();
	}

	if (result.deployed === true) {
		const route = routeUrl ? ` ${formatRouteUrl(routeUrl, origin)}` : "";
		if (result.fallback === true) {
			const details = message || "LLM generation failed; deployed a static fallback mini app.";
			return `${status}: ${slug} fallback deployed.${route} ${joinParts([details, attemptSummary])}`.trim();
		}

		return `${status}: ${slug} ${operation === "update" ? "updated" : "deployed"}.${route}`.trim();
	}

	return `${status}: ${slug}. ${joinParts([message, attemptSummary])}`.trim();
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

export function formatMiniAppBuildError(error: unknown, fallback: string): string {
	const message = formatAgentError(error, fallback).trim();
	if (/^Load failed\.?$/i.test(message)) {
		return "Mini app build workflow failed before returning a deployment result: Load failed. No mini app was activated.";
	}

	return message || fallback;
}

function formatRouteUrl(routeUrl: string, origin?: string): string {
	if (routeUrl.startsWith("/") && origin) {
		return `${origin}${routeUrl}`;
	}

	return routeUrl;
}

function formatAttemptSummary(value: unknown): string {
	if (!Array.isArray(value) || value.length === 0) {
		return "";
	}

	const attempts = value.map(formatAttempt).filter(Boolean);
	if (attempts.length === 0) {
		return "";
	}

	const visibleAttempts = attempts.slice(-2);
	const label = attempts.length === 1 ? "Attempt" : "Attempts";
	return `${label}: ${visibleAttempts.join(" | ")}`;
}

function formatAttempt(value: unknown, index: number): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return formatUnknown(value);
	}

	const record = value as Record<string, unknown>;
	const attempt = typeof record.attempt === "number" ? record.attempt : index + 1;
	const status = formatUnknown(record.status);
	const message = formatUnknown(record.message);
	const cleanup = formatUnknown(record.cleanup);
	const issues = Array.isArray(record.issues) ? record.issues.map(formatUnknown).filter(Boolean).join(" ") : "";
	const details = joinParts([message, issues, cleanup ? `cleanup: ${cleanup}` : ""]);

	return joinParts([`#${attempt}`, status, details]);
}

function joinParts(parts: string[]): string {
	return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

function formatUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "object") {
		const message = readStringProperty(value, "message") ?? readStringProperty(value, "error");
		if (message) {
			return message;
		}

		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	return String(value);
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
