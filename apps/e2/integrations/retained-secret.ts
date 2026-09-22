import type { ResourceState } from "alchemy/State";
import * as Redacted from "effect/Redacted";

// Keep values opaque: only Alchemy's provider may unwrap them. A deployment
// using this fallback must plan no updates or replacements for these secrets.
export const retainedSecretValue = (
	prior: ResourceState,
	name: string,
): Redacted.Redacted<string> => {
	if (
		prior.props?.name !== name || prior.attr?.secretName !== name ||
		!prior.attr?.secretId || !prior.attr?.storeId || !prior.attr?.accountId ||
		prior.props.store?.storeId !== prior.attr.storeId ||
		prior.props.store?.accountId !== prior.attr.accountId ||
		!Redacted.isRedacted(prior.props.value)
	) {
		throw new Error(`Cannot preserve deployment secret ${name}: invalid state`);
	}
	return prior.props.value as Redacted.Redacted<string>;
};
