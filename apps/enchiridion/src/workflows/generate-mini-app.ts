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
	buildMiniAppRepairPrompt,
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
			"Use signed host APIs for host data.",
			"Set bindings to [] because autonomous isolated binding provisioning is not implemented yet.",
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

type GeneratedMiniApp = v.InferOutput<typeof generatedMiniAppSchema>;

const maxGenerationAttempts = 3;

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
	const attempts: JsonObject[] = [];
	let prompt = buildMiniAppGenerationPrompt({
		userPrompt: payload.prompt,
		operation,
		installedExtensions,
		targetExtension,
		slugHint,
	});

	for (let attempt = 1; attempt <= maxGenerationAttempts; attempt += 1) {
		const response = await session.prompt(prompt, { result: generatedMiniAppSchema });
		const generated = response.data;
		const validation = validateGeneratedMiniApp({
			generated,
			installedExtensions,
			operation,
			targetExtension,
			autonomousDeploy: payload.autonomousDeploy !== false,
		});
		const slug = validation.manifest?.slug ?? generated.manifest.slug;

		if (!validation.ok || !validation.manifest) {
			attempts.push({
				attempt,
				status: "rejected",
				issues: validation.issues,
			});

			if (attempt < maxGenerationAttempts && validation.manifest) {
				prompt = buildMiniAppRepairPrompt({
					userPrompt: payload.prompt,
					operation,
					failureMessage: validation.issues.join("; "),
					manifest: validation.manifest,
					workerSource: generated.workerSource,
				});
				continue;
			}

			await createAuditRecord(env, {
				slug,
				action: `${operation}-mini-app`,
				status: validation.status,
				details: { issues: validation.issues, attempts },
			});

			return {
				status: validation.status,
				operation,
				slug,
				issues: validation.issues,
				deployed: false,
				attempts,
			};
		}

		const manifest = validation.manifest;
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
				attempts.push({
					attempt,
					status: "validation_failed",
					scriptName: deployment.scriptName,
					message: smokeTest.message,
					route: smokeTest.route,
				});

				if (attempt < maxGenerationAttempts) {
					prompt = buildMiniAppRepairPrompt({
						userPrompt: payload.prompt,
						operation,
						failureMessage: smokeTest.message,
						manifest,
						workerSource: generated.workerSource,
					});
					continue;
				}

				await createAuditRecord(env, {
					slug: manifest.slug,
					action: `${operation}-mini-app`,
					status: "validation_failed",
					details: {
						scriptName: deployment.scriptName,
						message: deployment.message,
						deploymentNotes: generated.deploymentNotes,
						validation: smokeTest as unknown as JsonObject,
						attempts,
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
					attempts,
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
					attempts,
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
				attempts,
			};
		}

		if (payload.autonomousDeploy !== false) {
			attempts.push({
				attempt,
				status: "deploy_failed",
				scriptName: deployment.scriptName,
				message: deployment.message,
			});

			if (attempt < maxGenerationAttempts && isRepairableDeploymentFailure(deployment.message)) {
				prompt = buildMiniAppRepairPrompt({
					userPrompt: payload.prompt,
					operation,
					failureMessage: deployment.message,
					manifest,
					workerSource: generated.workerSource,
				});
				continue;
			}

			await createAuditRecord(env, {
				slug: manifest.slug,
				action: `${operation}-mini-app`,
				status: "deploy_failed",
				details: {
					scriptName: deployment.scriptName,
					message: deployment.message,
					deploymentNotes: generated.deploymentNotes,
					attempts,
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
				attempts,
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
				attempts,
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
			attempts,
		};
	}

	throw new Error("Mini app generation failed without a terminal result.");
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

interface ValidatedMiniAppCandidate {
	ok: boolean;
	status: "rejected" | "requires_binding_provisioning";
	manifest?: ExtensionManifest;
	issues: string[];
}

export function validateGeneratedMiniApp(input: {
	generated: GeneratedMiniApp;
	installedExtensions: RegisteredExtension[];
	operation: MiniAppOperation;
	targetExtension?: RegisteredExtension;
	autonomousDeploy: boolean;
}): ValidatedMiniAppCandidate {
	const validation = validateExtensionManifest(input.generated.manifest);
	const issues = [...validation.issues];
	issues.push(...validateWorkerSource(input.generated.workerSource));

	if (input.operation === "update" && input.targetExtension && validation.manifest?.slug !== input.targetExtension.slug) {
		issues.push(`manifest.slug: update must keep target slug ${input.targetExtension.slug}`);
	}

	if (input.operation === "create" && input.installedExtensions.some((extension) => extension.slug === validation.manifest?.slug)) {
		issues.push(`manifest.slug: ${validation.manifest?.slug} already exists; use update instead`);
	}

	if (input.autonomousDeploy && validation.manifest && validation.manifest.bindings.length > 0) {
		const requested = validation.manifest.bindings.map((binding) => `${binding.name}:${binding.type}`).join(", ");
		issues.push(`bindings: autonomous deploy cannot provision isolated bindings yet (${requested}); return bindings: [] or use host APIs`);
	}

	if (input.autonomousDeploy && validation.manifest && !validation.manifest.routes.some((route) => route.mode === "worker-page")) {
		issues.push("routes: autonomous mini apps must expose at least one worker-page route");
	}

	return {
		ok: Boolean(validation.manifest) && issues.length === 0,
		status: issues.some((issue) => issue.startsWith("bindings: autonomous deploy cannot provision"))
			? "requires_binding_provisioning"
			: "rejected",
		manifest: validation.manifest,
		issues,
	};
}

export function isRepairableDeploymentFailure(message: string): boolean {
	return !message.includes("is not configured");
}

function validateWorkerSource(workerSource: string): string[] {
	const source = workerSource.trim();
	const issues: string[] = [];

	if (!/\bexport\s+default\b/.test(source)) {
		issues.push("workerSource: must export a default Cloudflare module Worker");
	}

	if (!/\bfetch\s*\(/.test(source)) {
		issues.push("workerSource: default export must include a fetch(request, env, ctx) handler");
	}

	const forbiddenPatterns: Array<[RegExp, string]> = [
		[/\bimport\s+[\s\S]*?\bfrom\b|\bimport\s*\(/, "workerSource: autonomous workers must be self-contained and cannot import modules"],
		[/\brequire\s*\(/, "workerSource: autonomous workers must be self-contained and cannot require modules"],
		[/\benv\s*\.\s*(ASSETS|DB|[A-Z][A-Z0-9_]*)\b/, "workerSource: autonomous workers cannot read env bindings; declare host APIs instead"],
		[/\b(window|document|localStorage|navigator)\s*\./, "workerSource: Cloudflare Workers cannot use browser globals during request handling"],
		[/\bprocess\s*\.\s*env\b/, "workerSource: Cloudflare Workers cannot read process.env"],
		[/\b(React|ReactDOM)\s*\.|jsx\s*\(/, "workerSource: generated Workers cannot depend on React or JSX runtimes"],
		[/\bfetch\s*\(\s*["'`]/, "workerSource: generated pages must not fetch external resources during route rendering"],
		[/Load failed/i, "workerSource: primary route must render useful HTML instead of a generic Load failed response"],
	];

	for (const [pattern, message] of forbiddenPatterns) {
		if (pattern.test(source)) {
			issues.push(message);
		}
	}

	return issues;
}
