import { z } from "zod";
import type { ExtensionManifest } from "./types";

export const allowedHostApis = [
	"notes:read",
	"notes:write",
	"resource-index:write",
	"resource-index:read",
	"tasks:create",
	"bookmarks:read",
	"bookmarks:write",
	"projects:read",
	"projects:write",
	"workflows:run",
] as const;

export const allowedBindingTypes = ["kv_namespace", "d1_database", "r2_bucket"] as const;
export const allowedRouteModes = ["worker-page", "worker-fragment", "host-primitive", "native-promoted"] as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());

const commandSchema = z.object({
	id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
	label: z.string().min(1),
	description: z.string().min(1),
	kind: z.enum(["navigate", "create", "workflow", "insert-block"]),
	scope: z.enum(["global", "daily-note", "selection", "app"]),
	app: z.string().min(1),
	action: z.string().min(1),
	inputSchema: jsonObjectSchema.optional(),
	requiredHostApis: z.array(z.enum(allowedHostApis)).default([]),
});

const editorBlockSchema = z.object({
	id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
	app: z.string().min(1),
	label: z.string().min(1),
	description: z.string().min(1),
	defaultProps: jsonObjectSchema.default({}),
	renderer: z.enum(["host-primitive", "worker-fragment", "native-promoted"]),
	requiredHostApis: z.array(z.enum(allowedHostApis)).default([]),
});

const manifestSchema = z.object({
	slug: z.string().min(2).regex(/^[a-z0-9][a-z0-9-]*$/),
	name: z.string().min(1),
	version: z.string().min(1),
	description: z.string().min(1),
	status: z.enum(["dynamic", "promoted", "disabled", "builtin"]).optional(),
	routes: z.array(z.object({
		path: z.string().min(1),
		mode: z.enum(allowedRouteModes),
		label: z.string().min(1),
		description: z.string().optional(),
	})).default([]),
	commands: z.array(commandSchema).default([]),
	editorBlocks: z.array(editorBlockSchema).default([]),
	workflows: z.array(z.object({
		id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
		label: z.string().min(1),
		trigger: z.enum(["manual", "scheduled", "webhook"]),
		workflowName: z.string().min(1),
		cron: z.string().optional(),
		inputSchema: jsonObjectSchema.optional(),
		requiredHostApis: z.array(z.enum(allowedHostApis)).default([]),
	})).default([]),
	bindings: z.array(z.object({
		type: z.enum(allowedBindingTypes),
		name: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/),
		purpose: z.string().min(1),
	})).default([]),
	hostApis: z.array(z.enum(allowedHostApis)).default([]),
	indexProjections: z.array(z.object({
		sourceType: z.string().min(1),
		titlePath: z.string().min(1),
		summaryPath: z.string().optional(),
		urlPath: z.string().optional(),
		tagsPath: z.string().optional(),
	})).default([]),
});

export interface ManifestValidationResult {
	ok: boolean;
	manifest?: ExtensionManifest;
	issues: string[];
}

export function validateExtensionManifest(input: unknown): ManifestValidationResult {
	const parsed = manifestSchema.safeParse(input);

	if (!parsed.success) {
		return {
			ok: false,
			issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`),
		};
	}

	const manifest = parsed.data as ExtensionManifest;
	const issues: string[] = [];

	for (const route of manifest.routes) {
		if (!route.path.startsWith(`/apps/${manifest.slug}`)) {
			issues.push(`routes.${route.path}: route must stay under /apps/${manifest.slug}`);
		}
	}

	for (const command of manifest.commands) {
		if (command.app !== manifest.slug) {
			issues.push(`commands.${command.id}: app must match manifest slug`);
		}
	}

	for (const block of manifest.editorBlocks) {
		if (block.app !== manifest.slug) {
			issues.push(`editorBlocks.${block.id}: app must match manifest slug`);
		}
	}

	const declaredApis = new Set(manifest.hostApis);
	for (const command of manifest.commands) {
		for (const api of command.requiredHostApis) {
			if (!declaredApis.has(api)) {
				issues.push(`commands.${command.id}: required host API ${api} is not declared`);
			}
		}
	}
	for (const block of manifest.editorBlocks) {
		for (const api of block.requiredHostApis) {
			if (!declaredApis.has(api)) {
				issues.push(`editorBlocks.${block.id}: required host API ${api} is not declared`);
			}
		}
	}

	if (manifest.bindings.length > 3) {
		issues.push("bindings: initial mini apps may request at most three isolated bindings");
	}

	return {
		ok: issues.length === 0,
		manifest,
		issues,
	};
}

export function assertValidManifest(input: unknown): ExtensionManifest {
	const result = validateExtensionManifest(input);

	if (!result.ok || !result.manifest) {
		throw new Error(`Invalid extension manifest: ${result.issues.join("; ")}`);
	}

	return result.manifest;
}
