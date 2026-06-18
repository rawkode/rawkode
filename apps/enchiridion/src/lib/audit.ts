import type { JsonObject } from "./types";

export type AuditTone = "neutral" | "success" | "warning" | "danger";

const successStatuses = new Set(["deployed", "fallback_deployed", "updated", "registered"]);
const warningStatuses = new Set(["rejected", "requires_binding_provisioning", "fallback_rejected", "deployed_pending", "updated_pending", "update_deferred", "fallback_deployed_pending"]);
const dangerStatuses = new Set(["deploy_failed", "fallback_deploy_failed", "fallback_validation_failed", "validation_failed", "error", "failed"]);

export function auditToneForStatus(status: string): AuditTone {
	if (successStatuses.has(status)) {
		return "success";
	}
	if (warningStatuses.has(status)) {
		return "warning";
	}
	if (dangerStatuses.has(status)) {
		return "danger";
	}
	return "neutral";
}

export function auditDetailSummary(details: JsonObject, status = ""): string {
	const operationalSummaries = auditOperationalSummaries(details);

	if (status === "fallback_deployed" || status === "fallback_deployed_pending") {
		const previousFailure = summarizeNestedDetails(details.previousFailure);
		if (previousFailure) {
			return joinSummaryParts([`Fallback deployed after ${previousFailure}`, ...operationalSummaries]);
		}
	}

	if (status.startsWith("fallback_") && status !== "fallback_deployed") {
		const currentFailure = summarizeNestedDetails(details.validation) || readString(details.message);
		const previousFailure = summarizeNestedDetails(details.previousFailure);
		return joinSummaryParts([
			currentFailure,
			previousFailure ? `Previous failure: ${previousFailure}` : "",
			...operationalSummaries,
		]);
	}

	const message = readString(details.message);
	if (message) {
		return joinSummaryParts([message, ...operationalSummaries]);
	}

	const issues = readStringArray(details.issues);
	if (issues.length > 0) {
		return joinSummaryParts([issues.join(" "), ...operationalSummaries]);
	}

	const validation = readObject(details.validation);
	const validationMessage = validation ? readString(validation.message) : "";
	if (validationMessage) {
		return joinSummaryParts([validationMessage, ...operationalSummaries]);
	}

	const attempts = readArray(details.attempts);
	const lastAttempt = readObject(attempts.at(-1));
	const attemptMessage = lastAttempt ? readString(lastAttempt.message) : "";
	if (attemptMessage) {
		return joinSummaryParts([attemptMessage, ...operationalSummaries]);
	}

	return joinSummaryParts([readString(details.deploymentNotes) || readString(details.scriptName), ...operationalSummaries]);
}

function auditOperationalSummaries(details: JsonObject): string[] {
	return [
		summarizeValidationAttempts(details.validationAttempts),
		summarizeSupersededCleanup(details.supersededScriptCleanup),
	].filter(Boolean);
}

function summarizeValidationAttempts(value: unknown): string {
	const attempts = readArray(value).map(readObject).filter((attempt): attempt is JsonObject => Boolean(attempt));
	if (attempts.length <= 1) {
		return "";
	}

	const last = attempts.at(-1);
	const status = last ? readString(last.status) : "";
	const message = last ? readString(last.message) : "";
	if (status === "passed") {
		return `Validation passed after ${attempts.length} attempts.`;
	}
	if (message) {
		return `Validation ended after ${attempts.length} attempts: ${message}`;
	}
	return `Validation ran ${attempts.length} attempts.`;
}

function summarizeSupersededCleanup(value: unknown): string {
	const cleanup = readObject(value);
	if (!cleanup) {
		return "";
	}

	const scriptName = readString(cleanup.scriptName);
	const message = readString(cleanup.message);
	if (cleanup.deleted === true) {
		return scriptName ? `Superseded Worker ${scriptName} removed.` : "Superseded Worker removed.";
	}
	if (cleanup.deleted === false) {
		return `Superseded Worker cleanup failed${scriptName ? ` for ${scriptName}` : ""}${message ? `: ${message}` : "."}`;
	}
	return message;
}

function joinSummaryParts(parts: string[]): string {
	return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

function summarizeNestedDetails(value: unknown): string {
	const details = readObject(value);
	if (!details) {
		return "";
	}

	const message = readString(details.message);
	if (message) {
		return message;
	}

	const issues = readStringArray(details.issues);
	if (issues.length > 0) {
		return issues.join(" ");
	}

	const validation = readObject(details.validation);
	const validationMessage = validation ? readString(validation.message) : "";
	if (validationMessage) {
		return validationMessage;
	}

	return readString(details.deploymentNotes) || readString(details.scriptName);
}

function readObject(value: unknown): JsonObject | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: null;
}

function readArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
