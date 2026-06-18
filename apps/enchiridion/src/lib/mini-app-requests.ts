import type { ExtensionManifest, RegisteredExtension } from "./types";

export type MiniAppOperation = "create" | "update";

export interface MiniAppIntent {
	shouldBuild: boolean;
	operation: MiniAppOperation;
	targetSlug?: string;
	slugHint?: string;
}

export interface MiniAppSummary {
	slug: string;
	name: string;
	status: ExtensionManifest["status"];
	description: string;
	routes: string[];
	commands: string[];
	editorBlocks: string[];
	deployedScriptName?: string | null;
}

const UPDATE_WORDS = /\b(update|change|modify|edit|rework|restyle|redesign|fix|improve|iterate|replace|add|remove)\b/i;
const CREATE_WORDS = /\b(create|build|make|generate|scaffold|new)\b/i;
const APP_WORDS = /\b(mini[- ]?app|web app|worker app|app|tool|page|dashboard|site)\b/i;
const APP_PREFIX = /^\s*(web app|mini[- ]?app|worker app|app)\b/i;

export function inferMiniAppIntent(
	prompt: string,
	extensions: Pick<ExtensionManifest, "slug" | "name">[],
	forceBuild = false,
): MiniAppIntent {
	const target = findReferencedExtension(prompt, extensions);
	const updateRequested = UPDATE_WORDS.test(prompt) && (target || APP_WORDS.test(prompt));
	const createRequested = forceBuild
		|| APP_PREFIX.test(prompt)
		|| (CREATE_WORDS.test(prompt) && APP_WORDS.test(prompt));

	if (updateRequested) {
		return {
			shouldBuild: true,
			operation: "update",
			targetSlug: target?.slug,
		};
	}

	if (createRequested) {
		return {
			shouldBuild: true,
			operation: "create",
			slugHint: target?.slug,
		};
	}

	return {
		shouldBuild: false,
		operation: "create",
	};
}

export function findReferencedExtension<T extends Pick<ExtensionManifest, "slug" | "name">>(
	prompt: string,
	extensions: T[],
	targetSlug?: string,
): T | undefined {
	if (targetSlug) {
		const normalizedTarget = normalize(targetSlug);
		return extensions.find((extension) => normalize(extension.slug) === normalizedTarget);
	}

	const normalizedPrompt = normalize(prompt);
	const candidates = extensions
		.flatMap((extension) => extensionAliases(extension).map((alias) => ({ extension, alias })))
		.filter((candidate) => candidate.alias.length > 1)
		.sort((left, right) => right.alias.length - left.alias.length);

	return candidates.find((candidate) => normalizedPrompt.includes(candidate.alias))?.extension;
}

export function summarizeMiniApp(extension: RegisteredExtension): MiniAppSummary {
	return {
		slug: extension.slug,
		name: extension.name,
		status: extension.status,
		description: extension.description,
		routes: extension.routes.map((route) => `${route.mode}:${route.path}`),
		commands: extension.commands.map((command) => `${command.id}:${command.label}`),
		editorBlocks: extension.editorBlocks.map((block) => `${block.id}:${block.label}`),
		deployedScriptName: extension.deployedScriptName,
	};
}

export function buildMiniAppGenerationPrompt(input: {
	userPrompt: string;
	operation: MiniAppOperation;
	installedExtensions: RegisteredExtension[];
	targetExtension?: RegisteredExtension;
	slugHint?: string;
}): string {
	const installedExtensions = input.installedExtensions.map(summarizeMiniApp);
	const sections = [
		`Request operation: ${input.operation}`,
		input.slugHint ? `Preferred slug: ${input.slugHint}` : "",
		input.targetExtension
			? [
				"Target existing mini app:",
				JSON.stringify({
					...summarizeMiniApp(input.targetExtension),
					manifest: input.targetExtension,
				}, null, 2),
			].join("\n")
			: "Target existing mini app: none",
		"Installed Enchiridion mini apps:",
		JSON.stringify(installedExtensions, null, 2),
		"User request:",
		input.userPrompt,
		"Generation rules:",
		"- Return a complete replacement manifest and complete Cloudflare module Worker source.",
		"- For update operations, keep the target manifest slug exactly the same.",
		"- For update operations, preserve existing routes, commands, editor blocks, workflows, host APIs, and index projections unless the user explicitly changes them.",
		"- For create operations, choose a new slug that does not collide with installed mini apps.",
		"- The manifest must include at least one worker-page route under /apps/<slug>.",
		"- The Worker must be a self-contained JavaScript module with export default { async fetch(request, env, ctx) { ... } }.",
		"- The Worker must return a useful text/html response with status 200 from its primary /apps/<slug> route.",
		"- Do not import modules, use JSX or React, depend on browser globals, read env bindings, fetch external resources during render, or delegate to env.ASSETS.",
		"- If the app needs host data, declare the matching hostApis entry and call only /api/host/* endpoints with the incoming x-enchiridion-host-context header.",
		"- The currently available host API is GET /api/host/resource-index/search?q=<query>&limit=<limit>, which requires hostApis: [\"resource-index:read\"].",
		"- Only call global fetch for the declared /api/host/resource-index/search host API. Do not mutate URL host, hostname, href, origin, port, protocol, pathname, search, or hash before fetching. Set query values with searchParams instead.",
		"- Build host API URLs with new URL(\"/api/host/resource-index/search\", request.url), then call fetch(url, { headers: { \"x-enchiridion-host-context\": request.headers.get(\"x-enchiridion-host-context\") ?? \"\" } }).",
		"- Do not return generic fallback bodies such as \"Load failed\". Render a complete page for the requested app.",
		"- Set bindings to [] for autonomous deploys. Dedicated KV, D1, and R2 provisioning is not available yet.",
		"- Return only fields matching the requested result schema.",
	];

	return sections.filter(Boolean).join("\n\n");
}

export function buildMiniAppRepairPrompt(input: {
	userPrompt: string;
	operation: MiniAppOperation;
	failureMessage: string;
	manifest: ExtensionManifest;
	workerSource: string;
}): string {
	return [
		"The previous generated mini app failed Enchiridion validation, deployment, or route smoke testing.",
		`Request operation: ${input.operation}`,
		"Original user request:",
		input.userPrompt,
		"Failure:",
		input.failureMessage,
		"Previous manifest:",
		JSON.stringify(input.manifest, null, 2),
		"Previous Worker source:",
		input.workerSource,
		"Repair rules:",
		"- Return a complete replacement manifest and complete Cloudflare module Worker source.",
		`- Keep the manifest slug exactly as ${input.manifest.slug}.`,
		"- Preserve the route namespace and make the primary /apps/<slug> route return a successful text/html response with status 200.",
		"- Use a self-contained JavaScript module worker: export default { async fetch(request, env, ctx) { ... } }.",
		"- Do not import modules, use JSX or React, depend on browser globals, read env bindings, fetch external resources during render, or delegate to env.ASSETS.",
		"- If the app needs host data, declare the matching hostApis entry and call only /api/host/* endpoints with the incoming x-enchiridion-host-context header.",
		"- The currently available host API is GET /api/host/resource-index/search?q=<query>&limit=<limit>, which requires hostApis: [\"resource-index:read\"].",
		"- Only call global fetch for the declared /api/host/resource-index/search host API. Do not mutate URL host, hostname, href, origin, port, protocol, pathname, search, or hash before fetching. Set query values with searchParams instead.",
		"- Build host API URLs with new URL(\"/api/host/resource-index/search\", request.url), then call fetch(url, { headers: { \"x-enchiridion-host-context\": request.headers.get(\"x-enchiridion-host-context\") ?? \"\" } }).",
		"- Do not return generic fallback bodies such as \"Load failed\". Render a complete page for the requested app.",
		"- Do not request KV, D1, or R2 bindings.",
		"- Return only fields matching the requested result schema.",
	].join("\n\n");
}

function extensionAliases(extension: Pick<ExtensionManifest, "slug" | "name">): string[] {
	return [
		normalize(extension.slug),
		normalize(extension.slug.replace(/-/g, " ")),
		normalize(extension.name),
	];
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}
