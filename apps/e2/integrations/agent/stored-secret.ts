import type * as BindingTypes from "../../node_modules/alchemy/lib/Cloudflare/Workers/Binding.d.ts";

// This helper has no public subpath export in the pinned Alchemy version.
const Binding: typeof BindingTypes = await import(
	new URL("./Cloudflare/Workers/Binding.js", import.meta.resolve("alchemy"))
		.href
);

const id = "Enchiridion.StoredVoiceSecret";
interface StoredVoiceSecret extends
	BindingTypes.Service<
		StoredVoiceSecret,
		typeof id,
		{ get(): Promise<string | null> }
	> {
	(): BindingTypes.Binding<
		typeof id,
		{ get(): Promise<string | null> },
		StoredVoiceSecret
	>;
}

/** Existing user-supplied Cloudflare secret; this binding never reads or rotates it at deploy time. */
export const StoredVoiceSecret = Binding.Service<StoredVoiceSecret>({
	id,
	defaultName: "OPENAI_API_KEY",
	toWorkerBinding: ({ name }: { name: string }) => ({
		type: "secrets_store_secret",
		name,
		storeId: "492e5e40b9d64ebeac7e7a77db91ff6e",
		secretName: "e2-production-agent-openai-api-key",
	}),
});
