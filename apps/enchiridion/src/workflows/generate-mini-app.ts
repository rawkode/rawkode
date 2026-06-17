import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import {
	candidateScriptNameForManifest,
	deployMiniAppWorker,
	scriptNameForManifest,
	smokeTestMiniAppWorker,
} from "../lib/cloudflare-dispatch";
import { validateExtensionManifest } from "../lib/extension-manifest";
import { registerRuntimeProviders } from "../lib/flue-providers";
import {
	buildMiniAppGenerationPrompt,
	findReferencedExtension,
	inferMiniAppIntent,
	type MiniAppOperation,
} from "../lib/mini-app-requests";
import { createAuditRecord, listRegisteredExtensions, saveExtension } from "../lib/repository";
import type { Env, ExtensionManifest, JsonObject, RegisteredExtension } from "../lib/types";

export const route: WorkflowRouteHandler = async (_c, next) => next();

const miniAppBuilder = createAgent<unknown, Env>(({ env }) => {
	registerRuntimeProviders(env);

	return {
		model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.6",
		instructions: [
			"Generate Enchiridion mini apps as Cloudflare module Workers.",
			"Return a strict extension manifest and one JavaScript module worker source.",
			"Routes must stay under /apps/<slug>.",
			"Mini apps must use signed host APIs for host data and isolated bindings for app-owned state.",
			"Never request direct access to the host DB binding.",
		].join(" "),
	};
});

const generatedMiniAppSchema = v.object({
	manifest: v.object({
		slug: v.string(),
		name: v.string(),
		version: v.string(),
		description: v.string(),
		routes: v.array(v.object({
			path: v.string(),
			mode: v.picklist(["worker-page", "worker-fragment", "host-primitive", "native-promoted"]),
			label: v.string(),
			description: v.optional(v.string()),
		})),
		commands: v.array(v.any()),
		editorBlocks: v.array(v.any()),
		workflows: v.array(v.any()),
		bindings: v.array(v.any()),
		hostApis: v.array(v.string()),
		indexProjections: v.array(v.any()),
	}),
	workerSource: v.string(),
	deploymentNotes: v.string(),
});

interface GenerateMiniAppPayload {
	prompt: string;
	slugHint?: string;
	operation?: MiniAppOperation;
	targetSlug?: string;
	autonomousDeploy?: boolean;
}

export async function run({ init, payload, env }: FlueContext<GenerateMiniAppPayload, Env>) {
	const installedExtensions = await listRegisteredExtensions(env);
	const inferred = inferMiniAppIntent(payload.prompt, installedExtensions, true);
	const operation = payload.operation ?? inferred.operation;
	const targetExtension = findReferencedExtension(
		payload.prompt,
		installedExtensions,
		payload.targetSlug ?? inferred.targetSlug,
	);
	const slugHint = payload.slugHint ?? inferred.slugHint ?? targetExtension?.slug;

	if (operation === "update") {
		const rejection = rejectInvalidUpdateTarget(targetExtension, payload.targetSlug ?? inferred.targetSlug);
		if (rejection) {
			await createAuditRecord(env, {
				slug: rejection.slug,
				action: "update-mini-app",
				status: "rejected",
				details: { issues: rejection.issues },
			});

			return {
				status: "rejected",
				operation,
				slug: rejection.slug,
				issues: rejection.issues,
				deployed: false,
			};
		}
	}

	const harness = await init(miniAppBuilder);
	const session = await harness.session();

	const response = await session.prompt(
		buildMiniAppGenerationPrompt({
			userPrompt: payload.prompt,
			operation,
			installedExtensions,
			targetExtension,
			slugHint,
		}),
		{ result: generatedMiniAppSchema },
	);

	const generated = response.data;
	const validation = validateExtensionManifest(generated.manifest);
	const slug = validation.manifest?.slug ?? generated.manifest.slug;
	const validationIssues = [...validation.issues];

	if (operation === "update" && targetExtension && validation.manifest?.slug !== targetExtension.slug) {
		validationIssues.push(`manifest.slug: update must keep target slug ${targetExtension.slug}`);
	}

	if (operation === "create" && installedExtensions.some((extension) => extension.slug === validation.manifest?.slug)) {
		validationIssues.push(`manifest.slug: ${validation.manifest?.slug} already exists; use update instead`);
	}

	if (!validation.ok || !validation.manifest || validationIssues.length > 0) {
		await createAuditRecord(env, {
			slug,
			action: `${operation}-mini-app`,
			status: "rejected",
			details: { issues: validationIssues },
		});

		return {
			status: "rejected",
			operation,
			slug,
			issues: validationIssues,
			deployed: false,
		};
	}

	const manifest = validation.manifest as ExtensionManifest;
	const deployment = payload.autonomousDeploy === false
		? {
			scriptName: scriptNameForManifest(manifest),
			deployed: false,
			message: "Autonomous deploy disabled for this run.",
		}
		: await deployMiniAppWorker(env, {
			manifest,
			workerSource: generated.workerSource,
			scriptName: candidateScriptNameForManifest(manifest),
		});

	if (deployment.deployed) {
		const smokeTest = await smokeTestMiniAppWorker(env, {
			manifest,
			scriptName: deployment.scriptName,
		});

		if (!smokeTest.ok) {
			await createAuditRecord(env, {
				slug: manifest.slug,
				action: `${operation}-mini-app`,
				status: "validation_failed",
				details: {
					scriptName: deployment.scriptName,
					message: deployment.message,
					deploymentNotes: generated.deploymentNotes,
					validation: smokeTest as unknown as JsonObject,
				},
			});

			return {
				status: "validation_failed",
				operation,
				slug: manifest.slug,
				scriptName: deployment.scriptName,
				deployed: false,
				message: smokeTest.message,
				validation: smokeTest,
				manifest,
			};
		}

		await saveExtension(env, manifest, deployment.scriptName, "dynamic");
		await createAuditRecord(env, {
			slug: manifest.slug,
			action: `${operation}-mini-app`,
			status: operation === "update" ? "updated" : "deployed",
			details: {
				scriptName: deployment.scriptName,
				message: deployment.message,
				deploymentNotes: generated.deploymentNotes,
				validation: smokeTest as unknown as JsonObject,
			},
		});

		return {
			status: operation === "update" ? "updated" : "deployed",
			operation,
			slug: manifest.slug,
			scriptName: deployment.scriptName,
			deployed: true,
			message: `${deployment.message} ${smokeTest.message}`,
			routeUrl: smokeTest.route,
			validation: smokeTest,
			manifest,
		};
	}

	if (payload.autonomousDeploy !== false) {
		await createAuditRecord(env, {
			slug: manifest.slug,
			action: `${operation}-mini-app`,
			status: "deploy_failed",
			details: {
				scriptName: deployment.scriptName,
				message: deployment.message,
				deploymentNotes: generated.deploymentNotes,
			},
		});

		return {
			status: "deploy_failed",
			operation,
			slug: manifest.slug,
			scriptName: deployment.scriptName,
			deployed: false,
			message: deployment.message,
			manifest,
		};
	}

	await saveExtension(env, manifest, deployment.deployed ? deployment.scriptName : null, "dynamic");
	await createAuditRecord(env, {
		slug: manifest.slug,
		action: `${operation}-mini-app`,
		status: "registered",
		details: {
			scriptName: deployment.scriptName,
			message: deployment.message,
			deploymentNotes: generated.deploymentNotes,
		},
	});

	return {
		status: "registered",
		operation,
		slug: manifest.slug,
		scriptName: deployment.scriptName,
		deployed: false,
		message: deployment.message,
		manifest,
	};
}

function rejectInvalidUpdateTarget(
	targetExtension: RegisteredExtension | undefined,
	requestedSlug?: string,
): { slug: string; issues: string[] } | null {
	if (!targetExtension) {
		return {
			slug: requestedSlug ?? "unknown",
			issues: [
				requestedSlug
					? `No registered mini app found for ${requestedSlug}.`
					: "No existing mini app matched the update request.",
			],
		};
	}

	if (targetExtension.status !== "dynamic") {
		return {
			slug: targetExtension.slug,
			issues: [`${targetExtension.slug} is ${targetExtension.status ?? "unknown"} and requires a host rebuild instead of dynamic Worker regeneration.`],
		};
	}

	if (!targetExtension.deployedScriptName) {
		return {
			slug: targetExtension.slug,
			issues: [`${targetExtension.slug} has no active deployed Worker to update.`],
		};
	}

	return null;
}
