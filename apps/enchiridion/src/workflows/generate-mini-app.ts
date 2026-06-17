import { createAgent, type FlueContext, type WorkflowRouteHandler } from "@flue/runtime";
import * as v from "valibot";
import { deployMiniAppWorker, scriptNameForManifest } from "../lib/cloudflare-dispatch";
import { validateExtensionManifest } from "../lib/extension-manifest";
import { registerRuntimeProviders } from "../lib/flue-providers";
import { createAuditRecord, saveExtension } from "../lib/repository";
import type { Env, ExtensionManifest } from "../lib/types";

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
	autonomousDeploy?: boolean;
}

export async function run({ init, payload, env }: FlueContext<GenerateMiniAppPayload, Env>) {
	const harness = await init(miniAppBuilder);
	const session = await harness.session();

	const response = await session.prompt(
		[
			"Create an Enchiridion mini app for this request:",
			payload.prompt,
			payload.slugHint ? `Preferred slug: ${payload.slugHint}` : "",
			"Return only fields matching the requested result schema.",
		].filter(Boolean).join("\n\n"),
		{ result: generatedMiniAppSchema },
	);

	const generated = response.data;
	const validation = validateExtensionManifest(generated.manifest);
	const slug = validation.manifest?.slug ?? generated.manifest.slug;

	if (!validation.ok || !validation.manifest) {
		await createAuditRecord(env, {
			slug,
			action: "generate-mini-app",
			status: "rejected",
			details: { issues: validation.issues },
		});

		return {
			status: "rejected",
			slug,
			issues: validation.issues,
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
		});

	await saveExtension(env, manifest, deployment.deployed ? deployment.scriptName : null, "dynamic");
	await createAuditRecord(env, {
		slug: manifest.slug,
		action: "generate-mini-app",
		status: deployment.deployed ? "deployed" : "registered",
		details: {
			scriptName: deployment.scriptName,
			message: deployment.message,
			deploymentNotes: generated.deploymentNotes,
		},
	});

	return {
		status: deployment.deployed ? "deployed" : "registered",
		slug: manifest.slug,
		scriptName: deployment.scriptName,
		deployed: deployment.deployed,
		message: deployment.message,
		manifest,
	};
}
