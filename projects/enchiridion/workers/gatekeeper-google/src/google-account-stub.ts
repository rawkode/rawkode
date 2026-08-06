// @enchiridion/worker-gatekeeper-google — shared "which GoogleAccountDO
// instance" resolver.
//
// Mirrors `workers/vault/src/vault-stub.ts` exactly: every call site that
// needs a `DurableObjectStub<GoogleAccountDO>` resolves it via
// `env.GOOGLE_ACCOUNT_DO.idFromName("default")` — a single, fixed DO name.
// This worker manages exactly one Google account (plan: single-user
// scope), so there is no per-account routing to do. A future multi-account
// retrofit only needs to change this one function.

import type { GoogleAccountDO } from "./google-account-do";

export interface DefaultGoogleAccountEnv {
  GOOGLE_ACCOUNT_DO: DurableObjectNamespace<GoogleAccountDO>;
}

export function defaultGoogleAccountStub(env: DefaultGoogleAccountEnv): DurableObjectStub<GoogleAccountDO> {
  const id = env.GOOGLE_ACCOUNT_DO.idFromName("default");
  return env.GOOGLE_ACCOUNT_DO.get(id);
}
