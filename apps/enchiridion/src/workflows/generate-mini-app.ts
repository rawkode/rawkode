import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import {
	candidateScriptNameForManifest,
	deleteMiniAppWorker,
	deployMiniAppWorker,
	isTransientMiniAppLoadFailure,
	scriptNameForManifest,
	smokeTestMiniAppWorker,
	type SmokeTestMiniAppResult,
} from "../lib/cloudflare-dispatch";
import { isAppRoutePath, validateExtensionManifest } from "../lib/extension-manifest";
import { registerRuntimeProviders } from "../lib/flue-providers";
import {
	buildMiniAppGenerationPrompt,
	buildMiniAppRepairPrompt,
	findReferencedExtension,
	inferMiniAppIntent,
	type MiniAppOperation,
} from "../lib/mini-app-requests";
import {
	appendMiniAppBuildEvent,
	createAuditRecord,
	createExtensionBindingRequest,
	completeMiniAppBuild,
	failMiniAppBuild,
	listRegisteredExtensions,
	markMiniAppBuildRunning,
	saveExtension,
} from "../lib/repository";
import type { Env, ExtensionManifest, JsonObject, RegisteredExtension } from "../lib/types";

export const route: WorkflowRouteHandler = async (_c, next) => next();

const miniAppBuilder = createAgent<unknown, Env>(({ env }) => {
	registerRuntimeProviders(env);

	return {
		model: "cloudflare-workers-ai/@cf/zai-org/glm-5.2",
		instructions: [
			"Generate Enchiridion mini apps as Cloudflare module Workers.",
			"Return a strict extension manifest and one JavaScript module worker source.",
			"Routes must stay under /apps/<slug>.",
			"Use signed host APIs for host data.",
			"Declare isolated bindings only when the app needs its own KV, D1, or R2 storage.",
			"Never request direct access to the host DB binding.",
			"For scheduled work, manifest workflows must use { id, label, trigger: \"scheduled\", workflowName: \"run-mini-app-workflow\", cron, requiredHostApis } and include a matching worker-fragment POST route at /apps/<slug>/_workflows/<id>.",
			"Generated dispatch Workers must not use timers, browser globals, Cache API state, script tags, inline event handlers, or browser-authenticated app APIs.",
		].join(" "),
	};
});

export const generatedMiniAppSchema = v.object({
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

export interface GenerateMiniAppPayload {
	prompt: string;
	slugHint?: string;
	operation?: MiniAppOperation;
	targetSlug?: string;
	autonomousDeploy?: boolean;
	buildId?: string;
	buildAttempt?: number;
	buildDeadlineAt?: string;
}

export type GeneratedMiniApp = v.InferOutput<typeof generatedMiniAppSchema>;

const maxGenerationAttempts = 3;
const maxSmokeTestAttempts = 4;
const smokeTestRetryDelaysMs = [250, 750, 1_500];
const maxWorkerSourceBytes = 64 * 1024;
const maxDeploymentNotesLength = 2_000;
const manifestCollectionLimits: Array<{
	key: keyof Pick<ExtensionManifest, "routes" | "commands" | "editorBlocks" | "workflows" | "indexProjections">;
	label: string;
	max: number;
}> = [
	{ key: "routes", label: "routes", max: 8 },
	{ key: "commands", label: "commands", max: 12 },
	{ key: "editorBlocks", label: "editor blocks", max: 12 },
	{ key: "workflows", label: "workflows", max: 8 },
	{ key: "indexProjections", label: "index projections", max: 12 },
];

interface MiniAppBuilderSession {
	prompt(prompt: string, options: { result: typeof generatedMiniAppSchema }): Promise<{ data: GeneratedMiniApp }>;
}

export async function run(ctx: FlueContext<GenerateMiniAppPayload, Env>) {
	const { payload, env, id } = ctx;
	if (payload.buildId) {
		await markMiniAppBuildRunning(env, {
			id: payload.buildId,
			runId: id,
			attempt: payload.buildAttempt ?? 1,
		});
	}

	try {
		const result = await runMiniAppGeneration(ctx);
		if (payload.buildId) {
			const resultObject = result as JsonObject;
			await completeMiniAppBuild(env, {
				id: payload.buildId,
				result: {
					...resultObject,
					runId: id,
				},
				status: miniAppBuildSucceeded(resultObject) ? "completed" : "failed",
				error: miniAppBuildSucceeded(resultObject) ? undefined : {
					message: readResultMessage(resultObject) ?? "Mini app build finished without an activatable app.",
					runId: id,
				},
			});
		}
		return result;
	} catch (error) {
		if (payload.buildId) {
			await failMiniAppBuild(env, {
				id: payload.buildId,
				status: "failed",
				error: {
					message: errorMessage(error),
					runId: id,
				},
			});
		}
		throw error;
	}
}

async function runMiniAppGeneration({ init, payload, env }: FlueContext<GenerateMiniAppPayload, Env>) {
	const installedExtensions = await listRegisteredExtensions(env);
	const inferred = inferMiniAppIntent(payload.prompt, installedExtensions, true);
	const operation = resolveMiniAppOperation(payload.operation, inferred.operation);
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

	const attempts: JsonObject[] = [];
	let prompt = buildMiniAppGenerationPrompt({
		userPrompt: payload.prompt,
		operation,
		installedExtensions,
		targetExtension,
		slugHint,
	});
	let session: MiniAppBuilderSession;

	try {
		const harness = await init(miniAppBuilder);
		session = await harness.session() as MiniAppBuilderSession;
	} catch (error) {
		const message = errorMessage(error);
		attempts.push({
			attempt: 1,
			status: "generation_failed",
			phase: "session",
			message,
		});
		await recordMiniAppBuildEvent(env, payload, {
			type: "generation_failed",
			message: `Builder session failed: ${message}`,
			details: { attempt: 1, phase: "session", message },
		});

		return finishGenerationFailure({
			env,
			payload,
			operation,
			targetExtension,
			slugHint,
			attempts,
			message,
		});
	}

	for (let attempt = 1; attempt <= maxGenerationAttempts; attempt += 1) {
		let generated: GeneratedMiniApp;
		try {
			const response = await session.prompt(prompt, { result: generatedMiniAppSchema });
			generated = response.data;
		} catch (error) {
			const message = errorMessage(error);
			attempts.push({
				attempt,
				status: "generation_failed",
				message,
			});
			await recordMiniAppBuildEvent(env, payload, {
				type: "generation_failed",
				message: `Attempt ${attempt} generation failed: ${message}`,
				details: { attempt, message },
			});

			if (attempt < maxGenerationAttempts) {
				prompt = buildGenerationFailureRetryPrompt(prompt, message);
				continue;
			}

			return finishGenerationFailure({
				env,
				payload,
				operation,
				targetExtension,
				slugHint,
				attempts,
				message,
			});
		}

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
			await recordMiniAppBuildEvent(env, payload, {
				type: "candidate_rejected",
				message: `Attempt ${attempt} candidate rejected: ${validation.issues[0] ?? "manifest validation failed"}`,
				details: { attempt, issues: validation.issues, status: validation.status },
			});

			if (validation.status === "requires_binding_provisioning" && validation.manifest) {
				return finishBindingProvisioningRequired({
					env,
					generated,
					manifest: validation.manifest,
					operation,
					issues: validation.issues,
					attempts,
				});
			}

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
		await recordMiniAppBuildEvent(env, payload, {
			type: "candidate_validated",
			message: `Attempt ${attempt} candidate validated for ${manifest.slug}.`,
			details: { attempt, slug: manifest.slug },
		});
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
			const smokeTestRun = await smokeTestMiniAppWorkerWithRetries(env, {
				manifest,
				scriptName: deployment.scriptName,
			});
			const smokeTest = smokeTestRun.result;
			await recordMiniAppBuildEvent(env, payload, {
				type: smokeTest.ok ? "smoke_test_passed" : "smoke_test_failed",
				message: smokeTest.ok
					? `Smoke test passed for ${manifest.slug}.`
					: `Smoke test failed for ${manifest.slug}: ${smokeTest.message}`,
				details: { attempt, smokeTest: smokeTest as unknown as JsonObject, validationAttempts: smokeTestRun.attempts },
			});

			if (!smokeTest.ok) {
				const transientSmokeTestRun = isTransientSmokeTestRun(smokeTestRun.attempts);
				const supersededScriptName = operation === "update" ? targetExtension?.deployedScriptName : undefined;
				if (transientSmokeTestRun && operation === "update" && supersededScriptName) {
					const cleanup = await cleanupMiniAppCandidate(env, deployment.scriptName);
					await createAuditRecord(env, {
						slug: manifest.slug,
						action: "update-mini-app",
						status: "update_deferred",
						details: {
							activeScriptName: supersededScriptName,
							candidateScriptName: deployment.scriptName,
							message: deployment.message,
							deploymentNotes: generated.deploymentNotes,
							validation: smokeTest as unknown as JsonObject,
							validationAttempts: smokeTestRun.attempts,
							cleanup: cleanup as unknown as JsonObject,
							attempts,
						},
					});

					return {
						status: "update_deferred",
						operation,
						slug: manifest.slug,
						scriptName: supersededScriptName,
						candidateScriptName: deployment.scriptName,
						deployed: false,
						activeRoutePreserved: true,
						message: `Update candidate was uploaded but not activated because dispatch did not become ready during smoke testing: ${smokeTest.message}`,
						routeUrl: smokeTest.route,
						validation: smokeTest,
						validationAttempts: smokeTestRun.attempts,
						cleanup,
						manifest,
						attempts,
					};
				}

				const cleanup = await deleteMiniAppWorker(env, deployment.scriptName);
				attempts.push({
					attempt,
					status: "validation_failed",
					scriptName: deployment.scriptName,
					message: smokeTest.message,
					route: smokeTest.route,
					smokeTestAttempts: smokeTestRun.attempts,
					cleanup: cleanup.message,
					transient: transientSmokeTestRun || undefined,
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
						validationAttempts: smokeTestRun.attempts,
						cleanup: cleanup as unknown as JsonObject,
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

			const supersededScriptName = operation === "update" ? targetExtension?.deployedScriptName : undefined;
			await saveExtension(env, manifest, deployment.scriptName, "dynamic");
			await recordMiniAppBuildEvent(env, payload, {
				type: operation === "update" ? "updated" : "deployed",
				message: `${operation === "update" ? "Updated" : "Deployed"} ${manifest.slug}.`,
				details: { attempt, slug: manifest.slug, scriptName: deployment.scriptName, routeUrl: smokeTest.route },
			});
			const supersededScriptCleanup = supersededScriptName && supersededScriptName !== deployment.scriptName
				? await cleanupMiniAppCandidate(env, supersededScriptName)
				: null;
			await createAuditRecord(env, {
				slug: manifest.slug,
				action: `${operation}-mini-app`,
				status: operation === "update" ? "updated" : "deployed",
				details: {
					scriptName: deployment.scriptName,
					supersededScriptName: supersededScriptCleanup ? supersededScriptName : undefined,
					supersededScriptCleanup,
					message: deployment.message,
					deploymentNotes: generated.deploymentNotes,
					validation: smokeTest as unknown as JsonObject,
					validationAttempts: smokeTestRun.attempts,
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
				validationAttempts: smokeTestRun.attempts,
				supersededScriptCleanup,
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
			await recordMiniAppBuildEvent(env, payload, {
				type: "deploy_failed",
				message: `Attempt ${attempt} deploy failed: ${deployment.message}`,
				details: { attempt, scriptName: deployment.scriptName, message: deployment.message },
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

export async function deployGeneratedMiniAppCandidate(input: {
	env: Env;
	payload: GenerateMiniAppPayload;
	generated: GeneratedMiniApp;
	attempts?: JsonObject[];
}): Promise<JsonObject> {
	const installedExtensions = await listRegisteredExtensions(input.env);
	const inferred = inferMiniAppIntent(input.payload.prompt, installedExtensions, true);
	const operation = resolveMiniAppOperation(input.payload.operation, inferred.operation);
	const targetExtension = findReferencedExtension(
		input.payload.prompt,
		installedExtensions,
		input.payload.targetSlug ?? inferred.targetSlug,
	);
	const attempt = Math.max(1, Math.trunc(input.payload.buildAttempt ?? 1));
	const attempts = input.attempts ?? [{
		attempt,
		status: "candidate_submitted",
		source: "mini-app-builder-agent",
	}];

	if (operation === "update") {
		const rejection = rejectInvalidUpdateTarget(targetExtension, input.payload.targetSlug ?? inferred.targetSlug);
		if (rejection) {
			await createAuditRecord(input.env, {
				slug: rejection.slug,
				action: "update-mini-app",
				status: "rejected",
				details: { issues: rejection.issues, attempts },
			});

			return {
				status: "rejected",
				operation,
				slug: rejection.slug,
				issues: rejection.issues,
				deployed: false,
				attempts,
			};
		}
	}

	const validation = validateGeneratedMiniApp({
		generated: input.generated,
		installedExtensions,
		operation,
		targetExtension,
		autonomousDeploy: input.payload.autonomousDeploy !== false,
	});
	const slug = validation.manifest?.slug ?? input.generated.manifest.slug;

	if (!validation.ok || !validation.manifest) {
		attempts.push({
			attempt,
			status: "rejected",
			issues: validation.issues,
		});
		await recordMiniAppBuildEvent(input.env, input.payload, {
			type: "candidate_rejected",
			message: `Candidate rejected: ${validation.issues[0] ?? "manifest validation failed"}`,
			details: { attempt, issues: validation.issues, status: validation.status },
		});

		if (validation.status === "requires_binding_provisioning" && validation.manifest) {
			return finishBindingProvisioningRequired({
				env: input.env,
				generated: input.generated,
				manifest: validation.manifest,
				operation,
				issues: validation.issues,
				attempts,
			}) as Promise<JsonObject>;
		}

		await createAuditRecord(input.env, {
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
	await recordMiniAppBuildEvent(input.env, input.payload, {
		type: "candidate_validated",
		message: `Candidate validated for ${manifest.slug}.`,
		details: { attempt, slug: manifest.slug },
	});
	const deployment = input.payload.autonomousDeploy === false
		? {
			scriptName: scriptNameForManifest(manifest),
			deployed: false,
			message: "Autonomous deploy disabled for this run.",
		}
		: await deployMiniAppWorker(input.env, {
			manifest,
			workerSource: input.generated.workerSource,
			scriptName: candidateScriptNameForManifest(manifest),
		});

	if (deployment.deployed) {
		const smokeTestRun = await smokeTestMiniAppWorkerWithRetries(input.env, {
			manifest,
			scriptName: deployment.scriptName,
		});
		const smokeTest = smokeTestRun.result;
		await recordMiniAppBuildEvent(input.env, input.payload, {
			type: smokeTest.ok ? "smoke_test_passed" : "smoke_test_failed",
			message: smokeTest.ok
				? `Smoke test passed for ${manifest.slug}.`
				: `Smoke test failed for ${manifest.slug}: ${smokeTest.message}`,
			details: { attempt, smokeTest: smokeTest as unknown as JsonObject, validationAttempts: smokeTestRun.attempts },
		});

		if (!smokeTest.ok) {
			const transientSmokeTestRun = isTransientSmokeTestRun(smokeTestRun.attempts);
			const supersededScriptName = operation === "update" ? targetExtension?.deployedScriptName : undefined;
			if (transientSmokeTestRun && operation === "update" && supersededScriptName) {
				const cleanup = await cleanupMiniAppCandidate(input.env, deployment.scriptName);
				await createAuditRecord(input.env, {
					slug: manifest.slug,
					action: "update-mini-app",
					status: "update_deferred",
					details: {
						activeScriptName: supersededScriptName,
						candidateScriptName: deployment.scriptName,
						message: deployment.message,
						deploymentNotes: input.generated.deploymentNotes,
						validation: smokeTest as unknown as JsonObject,
						validationAttempts: smokeTestRun.attempts,
						cleanup: cleanup as unknown as JsonObject,
						attempts,
					},
				});

				return {
					status: "update_deferred",
					operation,
					slug: manifest.slug,
					scriptName: supersededScriptName,
					candidateScriptName: deployment.scriptName,
					deployed: false,
					activeRoutePreserved: true,
					message: `Update candidate was uploaded but not activated because dispatch did not become ready during smoke testing: ${smokeTest.message}`,
					routeUrl: smokeTest.route,
					validation: smokeTest as unknown as JsonObject,
					validationAttempts: smokeTestRun.attempts,
					cleanup,
					manifest,
					attempts,
				};
			}

			const cleanup = await deleteMiniAppWorker(input.env, deployment.scriptName);
			attempts.push({
				attempt,
				status: "validation_failed",
				scriptName: deployment.scriptName,
				message: smokeTest.message,
				route: smokeTest.route,
				smokeTestAttempts: smokeTestRun.attempts,
				cleanup: cleanup.message,
				transient: transientSmokeTestRun || undefined,
			});

			await createAuditRecord(input.env, {
				slug: manifest.slug,
				action: `${operation}-mini-app`,
				status: "validation_failed",
				details: {
					scriptName: deployment.scriptName,
					message: deployment.message,
					deploymentNotes: input.generated.deploymentNotes,
					validation: smokeTest as unknown as JsonObject,
					validationAttempts: smokeTestRun.attempts,
					cleanup: cleanup as unknown as JsonObject,
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
				validation: smokeTest as unknown as JsonObject,
				manifest,
				attempts,
			};
		}

		const supersededScriptName = operation === "update" ? targetExtension?.deployedScriptName : undefined;
		await saveExtension(input.env, manifest, deployment.scriptName, "dynamic");
		await recordMiniAppBuildEvent(input.env, input.payload, {
			type: operation === "update" ? "updated" : "deployed",
			message: `${operation === "update" ? "Updated" : "Deployed"} ${manifest.slug}.`,
			details: { attempt, slug: manifest.slug, scriptName: deployment.scriptName, routeUrl: smokeTest.route },
		});
		const supersededScriptCleanup = supersededScriptName && supersededScriptName !== deployment.scriptName
			? await cleanupMiniAppCandidate(input.env, supersededScriptName)
			: null;
		await createAuditRecord(input.env, {
			slug: manifest.slug,
			action: `${operation}-mini-app`,
			status: operation === "update" ? "updated" : "deployed",
			details: {
				scriptName: deployment.scriptName,
				supersededScriptName: supersededScriptCleanup ? supersededScriptName : undefined,
				supersededScriptCleanup,
				message: deployment.message,
				deploymentNotes: input.generated.deploymentNotes,
				validation: smokeTest as unknown as JsonObject,
				validationAttempts: smokeTestRun.attempts,
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
			validation: smokeTest as unknown as JsonObject,
			validationAttempts: smokeTestRun.attempts,
			supersededScriptCleanup,
			manifest,
			attempts,
		};
	}

	if (input.payload.autonomousDeploy !== false) {
		attempts.push({
			attempt,
			status: "deploy_failed",
			scriptName: deployment.scriptName,
			message: deployment.message,
		});
		await recordMiniAppBuildEvent(input.env, input.payload, {
			type: "deploy_failed",
			message: `Deploy failed: ${deployment.message}`,
			details: { attempt, scriptName: deployment.scriptName, message: deployment.message },
		});

		await createAuditRecord(input.env, {
			slug: manifest.slug,
			action: `${operation}-mini-app`,
			status: "deploy_failed",
			details: {
				scriptName: deployment.scriptName,
				message: deployment.message,
				deploymentNotes: input.generated.deploymentNotes,
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

	await saveExtension(input.env, manifest, deployment.deployed ? deployment.scriptName : null, "dynamic");
	await createAuditRecord(input.env, {
		slug: manifest.slug,
		action: `${operation}-mini-app`,
		status: "registered",
		details: {
			scriptName: deployment.scriptName,
			message: deployment.message,
			deploymentNotes: input.generated.deploymentNotes,
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

function resolveMiniAppOperation(requested: MiniAppOperation | undefined, inferred: MiniAppOperation): MiniAppOperation {
	if (requested === "create" && inferred === "update") {
		return "update";
	}

	return requested ?? inferred;
}

function buildGenerationFailureRetryPrompt(currentPrompt: string, message: string): string {
	return [
		"The previous mini app generation call failed before returning a structured candidate.",
		`Failure: ${message}`,
		"Retry now and return only a complete schema-compliant Enchiridion mini app candidate.",
		currentPrompt,
	].join("\n\n");
}

async function recordMiniAppBuildEvent(
	env: Env,
	payload: GenerateMiniAppPayload,
	input: { type: string; message: string; details?: JsonObject },
): Promise<void> {
	if (!payload.buildId) {
		return;
	}

	await appendMiniAppBuildEvent(env, {
		buildId: payload.buildId,
		type: input.type,
		message: input.message,
		details: input.details,
	});
}

async function finishGenerationFailure(input: {
	env: Env;
	payload: GenerateMiniAppPayload;
	operation: MiniAppOperation;
	targetExtension?: RegisteredExtension;
	slugHint?: string;
	attempts: JsonObject[];
	message: string;
}) {
	const slug = input.targetExtension?.slug
		?? normalizeSlug(input.slugHint ?? slugFromPrompt(input.payload.prompt));
	await createAuditRecord(input.env, {
		slug,
		action: `${input.operation}-mini-app`,
		status: "generation_failed",
		details: {
			message: input.message,
			attempts: input.attempts,
		},
	});

	return {
		status: "generation_failed",
		operation: input.operation,
		slug,
		deployed: false,
		message: input.message,
		attempts: input.attempts,
	};
}

async function finishBindingProvisioningRequired(input: {
	env: Env;
	generated: GeneratedMiniApp;
	manifest: ExtensionManifest;
	operation: MiniAppOperation;
	issues: string[];
	attempts: JsonObject[];
}) {
	const request = await createExtensionBindingRequest(input.env, {
		operation: input.operation,
		manifest: input.manifest,
		workerSource: input.generated.workerSource,
		deploymentNotes: input.generated.deploymentNotes,
		issues: input.issues,
	});
	const bindings = input.manifest.bindings.map((binding) => ({
		name: binding.name,
		type: binding.type,
		purpose: binding.purpose,
	}));
	const message = `Mini app ${input.manifest.slug} needs isolated Cloudflare bindings before it can be deployed.`;

	await createAuditRecord(input.env, {
		slug: input.manifest.slug,
		action: `${input.operation}-mini-app`,
		status: "requires_binding_provisioning",
		details: {
			message,
			bindingRequestId: request.id,
			bindings,
			deploymentNotes: input.generated.deploymentNotes,
			issues: input.issues,
			attempts: input.attempts,
		},
	});

	return {
		status: "requires_binding_provisioning",
		operation: input.operation,
		slug: input.manifest.slug,
		deployed: false,
		message,
		bindingRequestId: request.id,
		bindings,
		manifest: input.manifest,
		attempts: input.attempts,
	};
}

async function smokeTestMiniAppWorkerWithRetries(
	env: Env,
	input: { manifest: ExtensionManifest; scriptName: string },
): Promise<{ result: SmokeTestMiniAppResult; attempts: JsonObject[] }> {
	let result: SmokeTestMiniAppResult | null = null;
	const attempts: JsonObject[] = [];

	for (let attempt = 1; attempt <= maxSmokeTestAttempts; attempt += 1) {
		result = await runSmokeTestMiniAppWorker(env, input);
		attempts.push(formatSmokeTestAttempt(attempt, result));

		if (result.ok || !isTransientSmokeTestFailure(result.message) || attempt === maxSmokeTestAttempts) {
			return { result, attempts };
		}

		await waitForSmokeTestRetry(attempt);
	}

	return {
		result: result ?? {
			ok: false,
			route: primaryWorkerPageRoute(input.manifest),
			message: "Smoke test did not run.",
		},
		attempts,
	};
}

async function runSmokeTestMiniAppWorker(
	env: Env,
	input: { manifest: ExtensionManifest; scriptName: string },
): Promise<SmokeTestMiniAppResult> {
	try {
		return await smokeTestMiniAppWorker(env, input);
	} catch (error) {
		return {
			ok: false,
			route: primaryWorkerPageRoute(input.manifest),
			message: errorMessage(error),
		};
	}
}

function formatSmokeTestAttempt(attempt: number, result: SmokeTestMiniAppResult): JsonObject {
	const record: JsonObject = {
		attempt,
		status: result.ok ? "passed" : "failed",
		route: result.route,
		message: result.message,
	};
	if (result.status !== undefined) {
		record.httpStatus = result.status;
	}
	if (result.contentType) {
		record.contentType = result.contentType;
	}

	return record;
}

function isTransientSmokeTestFailure(message: string): boolean {
	return isTransientMiniAppLoadFailure(message);
}

function isTransientSmokeTestRun(attempts: JsonObject[]): boolean {
	return attempts.length > 0
		&& attempts.every((attempt) => {
			const status = typeof attempt.status === "string" ? attempt.status : "";
			const message = typeof attempt.message === "string" ? attempt.message : "";
			return status === "failed" && isTransientSmokeTestFailure(message);
		});
}

function waitForSmokeTestRetry(attempt: number): Promise<void> {
	const delayMs = smokeTestRetryDelaysMs[Math.min(attempt - 1, smokeTestRetryDelaysMs.length - 1)] ?? 0;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function primaryWorkerPageRoute(manifest: ExtensionManifest): string {
	return manifest.routes.find((route) => route.mode === "worker-page")?.path ?? `/apps/${manifest.slug}`;
}

async function cleanupMiniAppCandidate(env: Env, scriptName: string): Promise<JsonObject> {
	try {
		return (await deleteMiniAppWorker(env, scriptName)) as unknown as JsonObject;
	} catch (error) {
		return {
			scriptName,
			deleted: false,
			message: errorMessage(error),
		};
	}
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

function slugFromPrompt(prompt: string): string {
	const stopWords = new Set([
		"a",
		"all",
		"an",
		"and",
		"app",
		"create",
		"for",
		"how",
		"make",
		"mini",
		"new",
		"the",
		"to",
		"web",
		"with",
	]);
	const words = prompt
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 2)
		.filter((word) => !stopWords.has(word))
		.slice(0, 6);
	return normalizeSlug(words.join("-") || "mini-app");
}

function normalizeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 64)
		|| "mini-app";
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
	issues.push(...validateGeneratedPayloadBounds(input.generated, validation.manifest));
	issues.push(...validateWorkerSource(input.generated.workerSource, validation.manifest));
	issues.push(...validateGeneratedBindingUsage(input.generated.workerSource, validation.manifest));

	if (input.operation === "update" && input.targetExtension && validation.manifest?.slug !== input.targetExtension.slug) {
		issues.push(`manifest.slug: update must keep target slug ${input.targetExtension.slug}`);
	}

	if (input.operation === "update" && input.targetExtension && validation.manifest) {
		issues.push(...validateUpdateCompatibility(input.targetExtension, validation.manifest));
	}

	if (input.operation === "create" && input.installedExtensions.some((extension) => extension.slug === validation.manifest?.slug)) {
		issues.push(`manifest.slug: ${validation.manifest?.slug} already exists; use update instead`);
	}

	const autonomousBindingRequest = Boolean(input.autonomousDeploy && validation.manifest && validation.manifest.bindings.length > 0);
	if (autonomousBindingRequest && validation.manifest) {
		const requested = validation.manifest.bindings.map((binding) => `${binding.name}:${binding.type}`).join(", ");
		issues.push(`bindings: autonomous deploy requires isolated binding provisioning first (${requested})`);
	}

	if (input.autonomousDeploy && validation.manifest && !validation.manifest.routes.some((route) => route.mode === "worker-page")) {
		issues.push("routes: autonomous mini apps must expose at least one worker-page route");
	}

	return {
		ok: Boolean(validation.manifest) && issues.length === 0,
		status: autonomousBindingRequest && issues.every(isBindingProvisioningIssue)
			? "requires_binding_provisioning"
			: "rejected",
		manifest: validation.manifest,
		issues,
	};
}

function validateUpdateCompatibility(targetExtension: RegisteredExtension, manifest: ExtensionManifest): string[] {
	const issues: string[] = [];
	const routeKeys = new Set(manifest.routes.map((route) => routeCompatibilityKey(route.path, route.mode)));
	for (const route of targetExtension.routes) {
		if (!routeKeys.has(routeCompatibilityKey(route.path, route.mode))) {
			issues.push(`routes.${route.path}: update must preserve existing ${route.mode} route`);
		}
	}

	issues.push(...missingIdIssues("commands", targetExtension.commands, manifest.commands));
	issues.push(...missingIdIssues("editorBlocks", targetExtension.editorBlocks, manifest.editorBlocks));
	issues.push(...missingIdIssues("workflows", targetExtension.workflows, manifest.workflows));
	issues.push(...missingValueIssues("hostApis", targetExtension.hostApis, manifest.hostApis));
	issues.push(...missingIndexProjectionIssues(targetExtension.indexProjections, manifest.indexProjections));

	return issues;
}

function routeCompatibilityKey(path: string, mode: string): string {
	return `${mode}:${path}`;
}

function missingIdIssues(
	collection: "commands" | "editorBlocks" | "workflows",
	existing: Array<{ id: string }>,
	generated: Array<{ id: string }>,
): string[] {
	const generatedIds = new Set(generated.map((entry) => entry.id));
	return existing
		.filter((entry) => !generatedIds.has(entry.id))
		.map((entry) => `${collection}.${entry.id}: update must preserve existing ${collectionLabel(collection)}`);
}

function missingValueIssues(collection: "hostApis", existing: string[], generated: string[]): string[] {
	const generatedValues = new Set(generated);
	return existing
		.filter((entry) => !generatedValues.has(entry))
		.map((entry) => `${collection}.${entry}: update must preserve existing host API declaration`);
}

function missingIndexProjectionIssues(
	existing: ExtensionManifest["indexProjections"],
	generated: ExtensionManifest["indexProjections"],
): string[] {
	const generatedSourceTypes = new Set(generated.map((projection) => projection.sourceType));
	return existing
		.filter((projection) => !generatedSourceTypes.has(projection.sourceType))
		.map((projection) => `indexProjections.${projection.sourceType}: update must preserve existing index projection`);
}

function collectionLabel(collection: "commands" | "editorBlocks" | "workflows"): string {
	if (collection === "editorBlocks") {
		return "editor block";
	}
	return collection.slice(0, -1);
}

function validateGeneratedPayloadBounds(generated: GeneratedMiniApp, manifest?: ExtensionManifest): string[] {
	const issues: string[] = [];
	const workerSourceBytes = byteLength(generated.workerSource);
	if (workerSourceBytes > maxWorkerSourceBytes) {
		issues.push(`workerSource: generated Worker source exceeds ${maxWorkerSourceBytes} bytes`);
	}

	if (generated.deploymentNotes.length > maxDeploymentNotesLength) {
		issues.push(`deploymentNotes: must be ${maxDeploymentNotesLength} characters or fewer`);
	}

	if (manifest) {
		for (const limit of manifestCollectionLimits) {
			if (manifest[limit.key].length > limit.max) {
				issues.push(`manifest.${limit.key}: generated mini apps may declare at most ${limit.max} ${limit.label}`);
			}
		}
	}

	return issues;
}

function isBindingProvisioningIssue(issue: string): boolean {
	return issue.startsWith("bindings: autonomous deploy requires isolated binding provisioning first");
}

export function isRepairableDeploymentFailure(message: string): boolean {
	return !message.includes("is not configured");
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || "Mini app generation failed.";
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object") {
		const message = readStringProperty(error, "message") ?? readStringProperty(error, "error");
		if (message) {
			return message;
		}
		try {
			return JSON.stringify(error);
		} catch {
			return "Mini app generation failed.";
		}
	}

	return String(error || "Mini app generation failed.");
}

export function miniAppBuildSucceeded(result: JsonObject): boolean {
	const status = typeof result.status === "string" ? result.status : "";
	return status === "deployed"
		|| status === "updated"
		|| status === "registered"
		|| status === "requires_binding_provisioning"
		|| status === "update_deferred";
}

function readResultMessage(result: JsonObject): string | undefined {
	const message = result.message;
	return typeof message === "string" && message.trim() ? message : undefined;
}

function readStringProperty(source: object, key: string): string | undefined {
	if (!(key in source)) {
		return undefined;
	}
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function validateWorkerSource(workerSource: string, manifest?: ExtensionManifest): string[] {
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
		[/\bctx\s*(?:\.|\?\.|\[)/, "workerSource: autonomous workers cannot use execution context side effects"],
		[/\beval\s*\(|\bnew\s+Function\s*\(/, "workerSource: generated Workers cannot evaluate dynamic code"],
		[/\bset(?:Timeout|Interval)\s*\(/, "workerSource: generated Workers cannot schedule background timers"],
		[/\bcaches\s*\./, "workerSource: autonomous workers cannot use undeclared cache storage"],
		[/\bWebSocket\s*\(|\bconnect\s*\(/, "workerSource: generated Workers cannot open network sockets"],
		[/\b(window|document|localStorage|navigator)\s*\./, "workerSource: Cloudflare Workers cannot use browser globals during request handling"],
		[/\bprocess\s*\.\s*env\b/, "workerSource: Cloudflare Workers cannot read process.env"],
		[/\b(React|ReactDOM)\s*\.|jsx\s*\(/, "workerSource: generated Workers cannot depend on React or JSX runtimes"],
		[/["'`]content-encoding["'`]\s*:/i, "workerSource: dynamic mini app pages cannot include Content-Encoding headers"],
		[/\bheaders\s*\.\s*set\s*\(\s*["'`]content-encoding["'`]/i, "workerSource: dynamic mini app pages cannot include Content-Encoding headers"],
		[/["'`]refresh["'`]\s*:/i, "workerSource: dynamic mini app pages cannot include Refresh navigation headers"],
		[/\bheaders\s*\.\s*set\s*\(\s*["'`]refresh["'`]/i, "workerSource: dynamic mini app pages cannot include Refresh navigation headers"],
		[/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh/i, "workerSource: dynamic mini app pages cannot trigger meta refresh navigation"],
		[/<script\b/i, "workerSource: dynamic mini app pages cannot include browser scripts; promote trusted UI into the host app instead"],
		[/<[^>]+\son[a-z]+\s*=/i, "workerSource: dynamic mini app pages cannot include inline browser event handlers"],
		[/javascript\s*:/i, "workerSource: dynamic mini app pages cannot include javascript: URLs"],
		[/<form\b/i, "workerSource: dynamic mini app pages cannot include forms because dynamic pages run in a sandbox"],
		[/\bfetch\s*\(\s*["'`]/, "workerSource: generated pages must not fetch external resources during route rendering"],
		[/\b(fetch|new Request)\s*\(\s*["'`]https?:\/\//, "workerSource: generated pages must not fetch external resources during route rendering"],
		[/\bnew\s+URL\s*\(\s*["'`]https?:\/\//, "workerSource: generated Workers must build URLs from request.url, not absolute external origins"],
		[/\/api\/(?!host\/)/, "workerSource: generated Workers must use /api/host/* for host APIs instead of browser-authenticated APIs"],
		[/Load failed/i, "workerSource: primary route must render useful HTML instead of a generic Load failed response"],
	];

	for (const [pattern, message] of forbiddenPatterns) {
		if (pattern.test(source)) {
			issues.push(message);
		}
	}

	issues.push(...validateWorkerEnvAccess(source, manifest));
	issues.push(...validateGeneratedFetchUsage(source));
	issues.push(...validateHostApiUsage(source, manifest));
	issues.push(...validateGeneratedHostApiScopes(source, manifest));
	issues.push(...validateWorkerRouteOwnership(source, manifest));

	return issues;
}

interface WorkerEnvAccess {
	name: string;
	index: number;
}

function validateWorkerEnvAccess(source: string, manifest?: ExtensionManifest): string[] {
	const declaredBindings = new Set((manifest?.bindings ?? []).map((binding) => binding.name));
	const namedAccesses = findWorkerEnvAccesses(source);
	const dynamicAccesses = findDynamicWorkerEnvAccesses(source);
	if (namedAccesses.length === 0 && dynamicAccesses.length === 0) {
		return [];
	}

	if (declaredBindings.size === 0) {
		return ["workerSource: autonomous workers cannot read env bindings; declare host APIs instead"];
	}

	const issues: string[] = [];
	if (dynamicAccesses.length > 0) {
		issues.push("workerSource: dynamic env binding lookup is not allowed; use declared binding names directly");
	}

	const undeclared = Array.from(new Set(namedAccesses.map((access) => access.name).filter((name) => !declaredBindings.has(name))));
	if (undeclared.length > 0) {
		issues.push(`workerSource: generated Workers can only read declared isolated bindings: ${undeclared.join(", ")}`);
	}

	return issues;
}

function validateGeneratedBindingUsage(source: string, manifest?: ExtensionManifest): string[] {
	if (!manifest || manifest.bindings.length === 0) {
		return [];
	}

	const usedBindings = new Set(findWorkerEnvAccesses(source).map((access) => access.name));
	const unusedBindings = manifest.bindings
		.map((binding) => binding.name)
		.filter((name) => !usedBindings.has(name));
	if (unusedBindings.length === 0) {
		return [];
	}

	return unusedBindings.map((name) => `bindings.${name}: declared isolated binding is not used by Worker source`);
}

function findWorkerEnvAccesses(source: string): WorkerEnvAccess[] {
	const accesses: WorkerEnvAccess[] = [];
	for (const match of source.matchAll(/\benv\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]*)/g)) {
		accesses.push({ name: match[1], index: match.index ?? -1 });
	}
	for (const match of source.matchAll(/\benv\s*(?:\?\.)?\s*\[\s*(["'`])([A-Z][A-Z0-9_]*)\1\s*\]/g)) {
		accesses.push({ name: match[2], index: match.index ?? -1 });
	}
	return accesses;
}

function findDynamicWorkerEnvAccesses(source: string): number[] {
	const stringLiteralBracketIndexes = new Set(
		Array.from(source.matchAll(/\benv\s*(?:\?\.)?\s*\[\s*(["'`])([A-Z][A-Z0-9_]*)\1\s*\]/g)).map((match) => match.index ?? -1),
	);
	return Array.from(source.matchAll(/\benv\s*(?:\?\.)?\s*\[/g))
		.map((match) => match.index ?? -1)
		.filter((index) => !stringLiteralBracketIndexes.has(index));
}

function validateWorkerRouteOwnership(source: string, manifest?: ExtensionManifest): string[] {
	if (!manifest) {
		return [];
	}

	const appRoutes = Array.from(source.matchAll(/\/apps\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9._~!$&'()*+,;=:@%/-]*)?/gi))
		.map((match) => match[0])
		.filter((path) => !isAppRoutePath(path, manifest.slug));
	const uniqueRoutes = Array.from(new Set(appRoutes));

	if (uniqueRoutes.length === 0) {
		return [];
	}

	return [`workerSource: app routes must stay under /apps/${manifest.slug}: ${uniqueRoutes.join(", ")}`];
}

interface GlobalFetchCall {
	index: number;
	argument: string;
	arguments: string[];
}

function validateGeneratedFetchUsage(source: string): string[] {
	const issues: string[] = [];
	if (/\b(?:globalThis|self)\s*\.\s*fetch\b/.test(source)
		|| /\bfetch\s*\.\s*(?:bind|call|apply)\s*\(/.test(source)
		|| /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:\b(?:globalThis|self)\s*\.\s*)?fetch\b/.test(source)
		|| /\b(?:const|let|var)\s*\{[^}]*\bfetch\b[^}]*\}\s*=\s*(?:globalThis|self)\b/.test(source)) {
		issues.push("workerSource: generated Workers must call fetch directly for declared host APIs");
	}

	const fetchCalls = findGlobalFetchCalls(source);
	if (fetchCalls.length === 0) {
		return issues;
	}

	const invalidFetchCalls = fetchCalls.filter((call) => !isAllowedHostApiFetchTarget(source, call.argument));
	if (invalidFetchCalls.length > 0) {
		issues.push("workerSource: generated Workers may only call fetch for declared host APIs");
	}

	if (/\.\s*(?:host|hostname|href|origin|port|protocol)\s*=/.test(source)) {
		issues.push("workerSource: generated Workers cannot mutate URL origins before fetch");
	}

	if (/\.\s*(?:hash|pathname|search)\s*=/.test(source)) {
		issues.push("workerSource: generated Workers cannot rewrite host API URL paths before fetch");
	}

	return issues;
}

function validateGeneratedHostApiScopes(source: string, manifest?: ExtensionManifest): string[] {
	if (!manifest) {
		return [];
	}

	const usedHostApis = new Set<string>();
	if (findHostApiPaths(source).includes("/api/host/resource-index/search")) {
		usedHostApis.add("resource-index:read");
	}
	for (const api of requiredHostApisForExtensionPoints(manifest)) {
		usedHostApis.add(api);
	}

	const unusedOrUnavailableApis = manifest.hostApis.filter((api) => !usedHostApis.has(api));
	if (unusedOrUnavailableApis.length === 0) {
		return [];
	}

	return [`hostApis: generated mini apps may only declare host APIs used by Worker source or extension points: ${unusedOrUnavailableApis.join(", ")}`];
}

function requiredHostApisForExtensionPoints(manifest: ExtensionManifest): string[] {
	return [
		...manifest.commands.flatMap((command) => command.requiredHostApis),
		...manifest.editorBlocks.flatMap((block) => block.requiredHostApis),
		...manifest.workflows.flatMap((workflow) => workflow.requiredHostApis),
	];
}

function findGlobalFetchCalls(source: string): GlobalFetchCall[] {
	const calls: GlobalFetchCall[] = [];
	for (const match of source.matchAll(/\bfetch\s*\(/g)) {
		const fetchIndex = match.index;
		if (fetchIndex === undefined) {
			continue;
		}
		const before = source.slice(0, fetchIndex).trimEnd();
		const previousChar = before.at(-1);
		if (previousChar === ".") {
			continue;
		}

		const openParenIndex = source.indexOf("(", fetchIndex);
		const closeParenIndex = findClosingParen(source, openParenIndex);
		if (closeParenIndex < 0 || isFetchHandlerDeclaration(source, fetchIndex, closeParenIndex)) {
			continue;
		}

		const args = splitTopLevelArguments(source.slice(openParenIndex + 1, closeParenIndex));
		calls.push({ index: fetchIndex, argument: args[0] ?? "", arguments: args });
	}

	return calls;
}

function isAllowedHostApiFetchTarget(source: string, argument: string): boolean {
	const trimmed = argument.trim();
	if (/^new\s+URL\s*\(\s*["'`]\/api\/host\/resource-index\/search["'`]\s*,\s*request\s*\.\s*url\s*\)/.test(trimmed)) {
		return true;
	}

	const identifier = /^[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0];
	if (!identifier) {
		return false;
	}

	return new RegExp(
		`\\bconst\\s+${escapeRegExp(identifier)}\\s*=\\s*new\\s+URL\\s*\\(\\s*["'\`]\\/api\\/host\\/resource-index\\/search["'\`]\\s*,\\s*request\\s*\\.\\s*url\\s*\\)`,
	).test(source);
}

function splitTopLevelArguments(argumentsSource: string): string[] {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let argumentStart = 0;
	const args: string[] = [];

	for (let index = 0; index < argumentsSource.length; index += 1) {
		const char = argumentsSource[index];

		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "\"" || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			depth += 1;
			continue;
		}
		if (char === ")" || char === "]" || char === "}") {
			depth -= 1;
			continue;
		}
		if (char === "," && depth === 0) {
			args.push(argumentsSource.slice(argumentStart, index).trim());
			argumentStart = index + 1;
		}
	}

	args.push(argumentsSource.slice(argumentStart).trim());
	return args.filter((arg) => arg.length > 0);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFetchHandlerDeclaration(source: string, fetchIndex: number, closeParenIndex: number): boolean {
	const after = source.slice(closeParenIndex + 1).trimStart();
	if (!after.startsWith("{")) {
		return false;
	}

	const before = source.slice(0, fetchIndex).trimEnd();
	const previousChar = before.at(-1);
	const previousWord = before.match(/[A-Za-z_$][\w$]*$/)?.[0];
	return previousWord === "async" || previousChar === "{" || previousChar === ",";
}

function findClosingParen(source: string, openParenIndex: number): number {
	if (openParenIndex < 0) {
		return -1;
	}

	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let index = openParenIndex; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];

		if (lineComment) {
			if (char === "\n") {
				lineComment = false;
			}
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "\"" || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}

	return -1;
}

function validateHostApiUsage(source: string, manifest?: ExtensionManifest): string[] {
	const issues: string[] = [];
	const hostApiPaths = findHostApiPaths(source);
	if (hostApiPaths.length === 0) {
		return issues;
	}

	const unsupportedHostApiPaths = hostApiPaths.filter((path) => path !== "/api/host/resource-index/search");
	if (unsupportedHostApiPaths.length > 0) {
		issues.push(`workerSource: unsupported host API path ${Array.from(new Set(unsupportedHostApiPaths)).join(", ")}`);
	}

	if (!manifest?.hostApis.includes("resource-index:read")) {
		issues.push("workerSource: /api/host/resource-index/search requires manifest.hostApis to include resource-index:read");
	}

	const hostApiFetchCalls = findGlobalFetchCalls(source)
		.filter((call) => isAllowedHostApiFetchTarget(source, call.argument));
	if (hostApiFetchCalls.some((call) => !fetchCallForwardsHostContext(call))) {
		issues.push("workerSource: host API calls must forward the incoming x-enchiridion-host-context header");
	}

	return issues;
}

function fetchCallForwardsHostContext(call: GlobalFetchCall): boolean {
	return call.arguments
		.slice(1)
		.join(",")
		.includes("x-enchiridion-host-context");
}

function findHostApiPaths(source: string): string[] {
	return Array.from(source.matchAll(/\/api\/host\/[a-z0-9_./-]*/gi)).map((match) => match[0]);
}
