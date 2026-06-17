import type { JsonObject } from "./types";

export type AuditTone = "neutral" | "success" | "warning" | "danger";

const successStatuses = new Set(["deployed", "updated", "registered"]);
const warningStatuses = new Set(["rejected", "requires_binding_provisioning"]);
const dangerStatuses = new Set(["deploy_failed", "validation_failed", "error", "failed"]);

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

export function auditDetailSummary(details: JsonObject): string {
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

	const attempts = readArray(details.attempts);
	const lastAttempt = readObject(attempts.at(-1));
	const attemptMessage = lastAttempt ? readString(lastAttempt.message) : "";
	if (attemptMessage) {
		return attemptMessage;
	}

	return readString(details.deploymentNotes) || readString(details.scriptName) || "";
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
