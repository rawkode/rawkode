import type { Env, ExtensionBinding, ExtensionManifest } from "./types";

type UploadBindingMetadata =
	| { type: "kv_namespace"; name: string; namespace_id: string }
	| { type: "d1"; name: string; database_id: string }
	| { type: "r2_bucket"; name: string; bucket_name: string };

export interface DeployMiniAppInput {
	manifest: ExtensionManifest;
	workerSource: string;
}

export interface DeployMiniAppResult {
	scriptName: string;
	deployed: boolean;
	message: string;
}

export async function deployMiniAppWorker(env: Env, input: DeployMiniAppInput): Promise<DeployMiniAppResult> {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;
	const namespace = env.CLOUDFLARE_DISPATCH_NAMESPACE;

	if (!accountId || !apiToken || !namespace) {
		return {
			scriptName: scriptNameForManifest(input.manifest),
			deployed: false,
			message: "Cloudflare account ID, API token, or dispatch namespace is not configured.",
		};
	}

	const scriptName = scriptNameForManifest(input.manifest);
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
