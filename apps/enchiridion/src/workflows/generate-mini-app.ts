import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import {
	candidateScriptNameForManifest,
	deleteMiniAppWorker,
	deployMiniAppWorker,
	scriptNameForManifest,
	smokeTestMiniAppWorker,
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

		return finishGenerationFailure({
			env,
			payload,
			operation,
			installedExtensions,
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

			if (attempt < maxGenerationAttempts) {
				prompt = buildGenerationFailureRetryPrompt(prompt, message);
				continue;
			}

			return finishGenerationFailure({
				env,
				payload,
				operation,
				installedExtensions,
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

			if (isFallbackEligibleValidationFailure(validation)) {
				const fallback = await maybeDeployFallbackMiniApp({
					env,
					payload,
					operation,
					installedExtensions,
					slugHint,
					attempts,
					failureStatus: validation.status,
					failureDetails: { issues: validation.issues },
				});
				if (fallback) {
					return fallback;
				}
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
				const cleanup = await deleteMiniAppWorker(env, deployment.scriptName);
				attempts.push({
					attempt,
					status: "validation_failed",
					scriptName: deployment.scriptName,
					message: smokeTest.message,
					route: smokeTest.route,
					cleanup: cleanup.message,
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

				const fallback = await maybeDeployFallbackMiniApp({
					env,
					payload,
					operation,
					installedExtensions,
					slugHint,
					attempts,
					failureStatus: "validation_failed",
					failureDetails: {
						scriptName: deployment.scriptName,
						message: deployment.message,
						deploymentNotes: generated.deploymentNotes,
						validation: smokeTest as unknown as JsonObject,
						cleanup: cleanup as unknown as JsonObject,
					},
				});
				if (fallback) {
					return fallback;
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

			if (isRepairableDeploymentFailure(deployment.message)) {
				const fallback = await maybeDeployFallbackMiniApp({
					env,
					payload,
					operation,
					installedExtensions,
					slugHint,
					attempts,
					failureStatus: "deploy_failed",
					failureDetails: {
						scriptName: deployment.scriptName,
						message: deployment.message,
						deploymentNotes: generated.deploymentNotes,
					},
				});
				if (fallback) {
					return fallback;
				}
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

function buildGenerationFailureRetryPrompt(currentPrompt: string, message: string): string {
	return [
		"The previous mini app generation call failed before returning a structured candidate.",
		`Failure: ${message}`,
		"Retry now and return only a complete schema-compliant Enchiridion mini app candidate.",
		currentPrompt,
	].join("\n\n");
}

async function finishGenerationFailure(input: {
	env: Env;
	payload: GenerateMiniAppPayload;
	operation: MiniAppOperation;
	installedExtensions: RegisteredExtension[];
	targetExtension?: RegisteredExtension;
	slugHint?: string;
	attempts: JsonObject[];
	message: string;
}) {
	const fallback = await maybeDeployFallbackMiniApp({
		env: input.env,
		payload: input.payload,
		operation: input.operation,
		installedExtensions: input.installedExtensions,
		slugHint: input.slugHint,
		attempts: input.attempts,
		failureStatus: "generation_failed",
		failureDetails: { message: input.message },
	});
	if (fallback) {
		return fallback;
	}

	const slug = input.targetExtension?.slug
		?? normalizeSlug(input.slugHint ?? fallbackSlugFromPrompt(input.payload.prompt));
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

async function maybeDeployFallbackMiniApp(input: {
	env: Env;
	payload: GenerateMiniAppPayload;
	operation: MiniAppOperation;
	installedExtensions: RegisteredExtension[];
	slugHint?: string;
	attempts: JsonObject[];
	failureStatus: string;
	failureDetails: JsonObject;
}) {
	if (input.operation !== "create" || input.payload.autonomousDeploy === false) {
		return null;
	}

	const generated = createFallbackMiniAppCandidate({
		userPrompt: input.payload.prompt,
		installedExtensions: input.installedExtensions,
		slugHint: input.slugHint,
	});
	const validation = validateGeneratedMiniApp({
		generated,
		installedExtensions: input.installedExtensions,
		operation: "create",
		autonomousDeploy: true,
	});

	if (!validation.ok || !validation.manifest) {
		await createAuditRecord(input.env, {
			slug: generated.manifest.slug,
			action: "create-mini-app",
			status: "fallback_rejected",
			details: {
				fallback: true,
				previousFailureStatus: input.failureStatus,
				previousFailure: input.failureDetails,
				issues: validation.issues,
				attempts: input.attempts,
			},
		});

		return {
			status: "fallback_rejected",
			operation: "create",
			slug: generated.manifest.slug,
			issues: validation.issues,
			deployed: false,
			attempts: input.attempts,
		};
	}

	const manifest = validation.manifest;
	const deployment = await deployMiniAppWorker(input.env, {
		manifest,
		workerSource: generated.workerSource,
		scriptName: candidateScriptNameForManifest(manifest),
	});

	if (!deployment.deployed) {
		await createAuditRecord(input.env, {
			slug: manifest.slug,
			action: "create-mini-app",
			status: "fallback_deploy_failed",
			details: {
				fallback: true,
				previousFailureStatus: input.failureStatus,
				previousFailure: input.failureDetails,
				scriptName: deployment.scriptName,
				message: deployment.message,
				attempts: input.attempts,
			},
		});

		return {
			status: "fallback_deploy_failed",
			operation: "create",
			slug: manifest.slug,
			scriptName: deployment.scriptName,
			deployed: false,
			message: deployment.message,
			manifest,
			attempts: input.attempts,
		};
	}

	const smokeTest = await smokeTestMiniAppWorker(input.env, {
		manifest,
		scriptName: deployment.scriptName,
	});

	if (!smokeTest.ok) {
		const cleanup = await deleteMiniAppWorker(input.env, deployment.scriptName);
		await createAuditRecord(input.env, {
			slug: manifest.slug,
			action: "create-mini-app",
			status: "fallback_validation_failed",
			details: {
				fallback: true,
				previousFailureStatus: input.failureStatus,
				previousFailure: input.failureDetails,
				scriptName: deployment.scriptName,
				message: deployment.message,
				deploymentNotes: generated.deploymentNotes,
				validation: smokeTest as unknown as JsonObject,
				cleanup: cleanup as unknown as JsonObject,
				attempts: input.attempts,
			},
		});

		return {
			status: "fallback_validation_failed",
			operation: "create",
			slug: manifest.slug,
			scriptName: deployment.scriptName,
			deployed: false,
			message: smokeTest.message,
			validation: smokeTest,
			manifest,
			attempts: input.attempts,
		};
	}

	await saveExtension(input.env, manifest, deployment.scriptName, "dynamic");
	await createAuditRecord(input.env, {
		slug: manifest.slug,
		action: "create-mini-app",
		status: "fallback_deployed",
		details: {
			fallback: true,
			previousFailureStatus: input.failureStatus,
			previousFailure: input.failureDetails,
			scriptName: deployment.scriptName,
			message: deployment.message,
			deploymentNotes: generated.deploymentNotes,
			validation: smokeTest as unknown as JsonObject,
			attempts: input.attempts,
		},
	});

	return {
		status: "deployed",
		operation: "create",
		slug: manifest.slug,
		scriptName: deployment.scriptName,
		deployed: true,
		fallback: true,
		message: `LLM generation failed; deployed a static fallback mini app. ${deployment.message} ${smokeTest.message}`,
		routeUrl: smokeTest.route,
		validation: smokeTest,
		manifest,
		attempts: input.attempts,
	};
}

export function createFallbackMiniAppCandidate(input: {
	userPrompt: string;
	installedExtensions: Pick<RegisteredExtension, "slug">[];
	slugHint?: string;
}): GeneratedMiniApp {
	const slug = uniqueFallbackSlug(input.slugHint ?? fallbackSlugFromPrompt(input.userPrompt), input.installedExtensions);
	const name = fallbackNameFromSlug(slug);
	const routePath = `/apps/${slug}`;
	const prompt = input.userPrompt.trim() || "Untitled mini app";
	const description = `Static fallback mini app generated after autonomous app-builder repair attempts failed.`;
	const html = renderFallbackHtml({ name, prompt });

	return {
		manifest: {
			slug,
			name,
			version: "0.1.0",
			description,
			routes: [{
				path: routePath,
				mode: "worker-page",
				label: name,
				description: "Independent fallback route served by a dynamic Worker.",
			}],
			commands: [{
				id: "open",
				label: `Open ${name}`,
				description: `Open the ${name} mini app.`,
				kind: "navigate",
				scope: "global",
				app: slug,
				action: routePath,
				requiredHostApis: [],
			}],
			editorBlocks: [],
			workflows: [],
			bindings: [],
			hostApis: [],
			indexProjections: [],
		},
		workerSource: [
			`const html = ${JSON.stringify(html)};`,
			"export default {",
			"	async fetch(request) {",
			"		const url = new URL(request.url);",
			`		if (!url.pathname.startsWith(${JSON.stringify(routePath)})) {`,
			`			return Response.redirect(new URL(${JSON.stringify(routePath)}, url), 302);`,
			"		}",
			"		return new Response(html, {",
			"			status: 200,",
			"			headers: { \"content-type\": \"text/html; charset=utf-8\" },",
			"		});",
			"	},",
			"};",
		].join("\n"),
		deploymentNotes: "Deployed deterministic static fallback after LLM-generated candidates failed validation, deployment, or smoke testing.",
	};
}

function fallbackSlugFromPrompt(prompt: string): string {
	const words = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 1 && !fallbackSlugStopWords.has(word));
	const slug = words.slice(0, 6).join("-");
	return slug || "mini-app";
}

function uniqueFallbackSlug(baseSlug: string, installedExtensions: Pick<RegisteredExtension, "slug">[]): string {
	const normalized = normalizeSlug(baseSlug);
	const existing = new Set(installedExtensions.map((extension) => extension.slug));

	if (!existing.has(normalized)) {
		return normalized;
	}

	for (let suffix = 2; suffix <= 99; suffix += 1) {
		const candidate = `${normalized}-${suffix}`;
		if (!existing.has(candidate)) {
			return candidate;
		}
	}

	return `${normalized}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 54)
		.replace(/-+$/g, "") || "mini-app";
}

function fallbackNameFromSlug(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function renderFallbackHtml(input: { name: string; prompt: string }): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>${escapeHtml(input.name)}</title>
		<style>
			:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
			body { margin: 0; background: #f7f8f3; color: #20211d; }
			main { max-width: 920px; margin: 0 auto; padding: 48px 24px 64px; }
			header { border-bottom: 1px solid #d6d9cd; padding-bottom: 24px; margin-bottom: 28px; }
			p { line-height: 1.65; }
			.panel { border: 1px solid #d6d9cd; background: #ffffff; border-radius: 8px; padding: 22px; margin: 18px 0; }
			.kicker { color: #5f6b2d; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
			.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
			.item { border-left: 3px solid #6b7f32; padding-left: 14px; }
			code { background: #eef0e6; border-radius: 4px; padding: 2px 5px; }
		</style>
	</head>
	<body>
		<main>
			<header>
				<div class="kicker">Enchiridion fallback mini app</div>
				<h1>${escapeHtml(input.name)}</h1>
				<p>This static app was generated because the autonomous Worker candidates did not pass validation or smoke testing.</p>
			</header>
			<section class="panel">
				<h2>Request</h2>
				<p>${escapeHtml(input.prompt)}</p>
			</section>
			<section class="grid" aria-label="Next steps">
				<div class="item">
					<h2>Use It Now</h2>
					<p>The route is live and can be replaced by asking the agent to update this mini app with more specific behavior.</p>
				</div>
				<div class="item">
					<h2>Make It Richer</h2>
					<p>Add data capture, commands, editor blocks, or host API access once the workflow requirements are clear.</p>
				</div>
				<div class="item">
					<h2>Promote Later</h2>
					<p>If this becomes important, promote it into host-native UI through an explicit rebuild.</p>
				</div>
			</section>
		</main>
	</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const fallbackSlugStopWords = new Set([
	"a",
	"an",
	"and",
	"app",
	"for",
	"how",
	"make",
	"mini",
	"new",
	"page",
	"simple",
	"site",
	"the",
	"to",
	"tool",
	"web",
	"with",
]);

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

function isFallbackEligibleValidationFailure(validation: ValidatedMiniAppCandidate): boolean {
	return validation.status !== "requires_binding_provisioning"
		&& !validation.issues.some((issue) => issue.includes("already exists; use update instead"));
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
		[/\benv\s*(?:\.|\?\.|\[)/, "workerSource: autonomous workers cannot read env bindings; declare host APIs instead"],
		[/\bctx\s*(?:\.|\?\.|\[)/, "workerSource: autonomous workers cannot use execution context side effects"],
		[/\beval\s*\(|\bnew\s+Function\s*\(/, "workerSource: generated Workers cannot evaluate dynamic code"],
		[/\bset(?:Timeout|Interval)\s*\(/, "workerSource: generated Workers cannot schedule background timers"],
		[/\bcaches\s*\./, "workerSource: autonomous workers cannot use undeclared cache storage"],
		[/\bWebSocket\s*\(|\bconnect\s*\(/, "workerSource: generated Workers cannot open network sockets"],
		[/\b(window|document|localStorage|navigator)\s*\./, "workerSource: Cloudflare Workers cannot use browser globals during request handling"],
		[/\bprocess\s*\.\s*env\b/, "workerSource: Cloudflare Workers cannot read process.env"],
		[/\b(React|ReactDOM)\s*\.|jsx\s*\(/, "workerSource: generated Workers cannot depend on React or JSX runtimes"],
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

	issues.push(...validateGeneratedFetchUsage(source));
	issues.push(...validateHostApiUsage(source, manifest));
	issues.push(...validateGeneratedHostApiScopes(source, manifest));
	issues.push(...validateWorkerRouteOwnership(source, manifest));

	return issues;
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

	const unusedOrUnavailableApis = manifest.hostApis.filter((api) => !usedHostApis.has(api));
	if (unusedOrUnavailableApis.length === 0) {
		return [];
	}

	return [`hostApis: generated mini apps may only declare host APIs used by Worker source: ${unusedOrUnavailableApis.join(", ")}`];
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

		const argument = firstCallArgument(source.slice(openParenIndex + 1, closeParenIndex));
		calls.push({ index: fetchIndex, argument });
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

function firstCallArgument(argumentsSource: string): string {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;

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
			return argumentsSource.slice(0, index);
		}
	}

	return argumentsSource;
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

	if (!source.includes("x-enchiridion-host-context")) {
		issues.push("workerSource: host API calls must forward the incoming x-enchiridion-host-context header");
	}

	return issues;
}

function findHostApiPaths(source: string): string[] {
	return Array.from(source.matchAll(/\/api\/host\/[a-z0-9_./-]*/gi)).map((match) => match[0]);
}
