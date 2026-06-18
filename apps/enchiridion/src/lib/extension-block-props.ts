import type { JsonObject } from "./types";

export function mergeExtensionBlockProps(current: JsonObject, patch: JsonObject): JsonObject {
	return {
		...current,
		...patch,
	};
}

export function readExtensionBlockString(props: JsonObject, key: string): string {
	const value = props[key];
	return typeof value === "string" ? value : "";
}
