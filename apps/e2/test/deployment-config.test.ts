import { strict as assert } from "node:assert";
import type { ResourceState } from "alchemy/State";
import * as Redacted from "effect/Redacted";
import { retainedSecretValue } from "../integrations/retained-secret.ts";

const fixture = () => ({
	status: "created" as const,
	resourceType: "Cloudflare.SecretsStore.Secret",
	namespace: undefined,
	fqn: "google-client-secret",
	logicalId: "google-client-secret",
	instanceId: "instance",
	providerVersion: 1,
	downstream: [],
	bindings: [],
	props: {
		name: "e2-production-google-client-secret",
		store: { storeId: "store", accountId: "account" },
		value: Redacted.make("test-only-secret"),
	},
	attr: {
		secretName: "e2-production-google-client-secret",
		secretId: "secret",
		storeId: "store",
		accountId: "account",
	},
});

Deno.test("retained deployment credentials preserve the opaque wrapper", () => {
	const prior = fixture();
	assert.equal(
		retainedSecretValue(prior as ResourceState, prior.props.name),
		prior.props.value,
	);
});

Deno.test("retained deployment credentials reject another secret or store", () => {
	const prior = fixture();
	assert.throws(() =>
		retainedSecretValue(prior as ResourceState, "another-secret")
	);
	prior.props.store.storeId = "other-store";
	assert.throws(() =>
		retainedSecretValue(prior as ResourceState, prior.props.name)
	);
});

Deno.test("retained deployment credentials reject malformed state without exposing it", () => {
	const prior = fixture();
	const malformed = {
		...prior,
		props: { ...prior.props, value: "test-only-secret" },
	} as ResourceState;
	assert.throws(
		() => retainedSecretValue(malformed, prior.props.name),
		(error: unknown) =>
			error instanceof Error && !error.message.includes("test-only-secret"),
	);
	assert.throws(() =>
		retainedSecretValue({} as ResourceState, prior.props.name)
	);
});
