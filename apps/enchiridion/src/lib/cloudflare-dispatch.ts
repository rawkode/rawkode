import type { Env, ExtensionBinding, ExtensionManifest } from "./types";
import { signHostContext } from "./host-context";

type UploadBindingMetadata =
	| { type: "kv_namespace"; name: string; namespace_id: string }
	| { type: "d1"; name: string; database_id: string }
	| { type: "r2_bucket"; name: string; bucket_name: string };

export interface DeployMiniAppInput {
	manifest: ExtensionManifest;
	workerSource: string;
	scriptName?: string;
}

export interface DeployMiniAppResult {
	scriptName: string;
	deployed: boolean;
	message: string;
}

export interface SmokeTestMiniAppResult {
	ok: boolean;
	route: string;
	status?: number;
	contentType?: string | null;
	message: string;
}

export async function deployMiniAppWorker(env: Env, input: DeployMiniAppInput): Promise<DeployMiniAppResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	const namespace = env.CLOUDFLARE_DISPATCH_NAMESPACE;
	const scriptName = input.scriptName ?? scriptNameForManifest(input.manifest);

	if (!accountId || !apiToken || !namespace) {
		return {
			scriptName,
			deployed: false,
			message: "Cloudflare account ID, API token, or dispatch namespace is not configured.",
		};
	}

	const mainModule = `${scriptName}.mjs`;
	const form = new FormData();
	form.append("metadata", new Blob([JSON.stringify({
		main_module: mainModule,
		compatibility_date: "2026-06-17",
		bindings: bindingsToUploadMetadata(input.manifest.bindings),
		tags: ["enchiridion", input.manifest.slug],
	})], { type: "application/json" }));
	form.append(mainModule, new File([input.workerSource], mainModule, { type: "application/javascript+module" }));

	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
		{
			method: "PUT",
			headers: { authorization: `Bearer ${apiToken}` },
			body: form,
		},
	);

	if (!response.ok) {
		return {
			scriptName,
			deployed: false,
			message: `Cloudflare upload failed with ${response.status}: ${await response.text()}`,
		};
	}

	return {
		scriptName,
		deployed: true,
		message: "Mini app Worker deployed.",
	};
}

export function scriptNameForManifest(manifest: Pick<ExtensionManifest, "slug">): string {
	return `enchiridion-${manifest.slug}`;
}

export function candidateScriptNameForManifest(manifest: Pick<ExtensionManifest, "slug">): string {
	const suffix = crypto.randomUUID().slice(0, 8);
	const base = scriptNameForManifest(manifest);
	return `${base.slice(0, 54)}-${suffix}`;
}

export async function smokeTestMiniAppWorker(
	env: Env,
	input: { manifest: ExtensionManifest; scriptName: string },
): Promise<SmokeTestMiniAppResult> {
	const route = primaryRouteForManifest(input.manifest);
	if (!env.MINI_APP_DISPATCHER) {
		return {
			ok: false,
			route,
			message: "Dispatch namespace binding is not configured.",
		};
	}

	const secret = env.HOST_SIGNING_SECRET ?? "dev-host-signing-secret";
	const token = await signHostContext({
		app: input.manifest.slug,
		scopes: input.manifest.hostApis,
		expiresAt: Date.now() + 5 * 60 * 1000,
		context: { path: route, smokeTest: true },
	}, secret);

	const url = new URL(route, "https://enchiridion.local");
	const request = new Request(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
			"x-enchiridion-host-context": token,
		},
	});

	try {
		const response = await env.MINI_APP_DISPATCHER.get(input.scriptName).fetch(request);
		const contentType = response.headers.get("content-type");
		if (!response.ok) {
			const body = await response.text();
			return {
				ok: false,
				route,
				status: response.status,
				contentType,
				message: `Smoke test failed with ${response.status}: ${body.slice(0, 500)}`,
			};
		}

		return {
			ok: true,
			route,
			status: response.status,
			contentType,
			message: "Primary mini-app route rendered successfully.",
		};
	} catch (error) {
		return {
			ok: false,
			route,
			message: error instanceof Error ? error.message : "Smoke test failed.",
		};
	}
}

function bindingsToUploadMetadata(bindings: ExtensionBinding[]): UploadBindingMetadata[] {
	return bindings.map((binding) => {
		if (binding.type === "kv_namespace") {
			return { type: "kv_namespace", name: binding.name, namespace_id: `${binding.name}_ID_REQUIRED` };
		}
		if (binding.type === "d1_database") {
			return { type: "d1", name: binding.name, database_id: `${binding.name}_ID_REQUIRED` };
		}
		return { type: "r2_bucket", name: binding.name, bucket_name: `${binding.name.toLowerCase().replace(/_/g, "-")}-required` };
	});
}

function primaryRouteForManifest(manifest: ExtensionManifest): string {
	return manifest.routes.find((route) => route.mode === "worker-page")?.path
		?? manifest.routes[0]?.path
		?? `/apps/${manifest.slug}`;
}
