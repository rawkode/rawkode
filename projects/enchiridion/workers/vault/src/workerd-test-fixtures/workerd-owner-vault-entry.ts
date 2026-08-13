// TEST-ONLY Workerd entry (Wrangler `main` for
// v2/owner-vault/wrangler.owner-vault-workerd-test.jsonc). It lives outside
// the deployable `src/v2` root because it is test support, not production
// source: Worker `fetch` is the one native Promise adapter required by
// Wrangler, and the composition itself remains Effect-based. It is
// deliberately not named as a Bun test module: it must export the Durable
// Object classes, whose `cloudflare:workers` import only resolves in Workerd.
import {
  type DurableObjectBoundary,
  type DurableObjectStorage,
  type DurableObjectTransaction,
  makeDurableObjectBoundary,
  makeP256Crypto,
  makeWorkerBoundary,
  ownerVaultSocketAdmissionPath,
} from "@enchiridion/runtime";
import { Effect } from "effect";
import {
  ownerVaultFloorSyncPath,
  ownerVaultInitializationPath,
  ownerVaultObjectName,
} from "../v2/directory/lifecycle";
import {
  type OwnerVaultDirectoryControlFactory,
  makeVaultV2EntryCompositionCache,
  parseVaultV2EntryEnv,
} from "../v2/entry/composition";
import { CredentialDirectoryDO } from "../v2/entry/index";
import type { OwnerVaultProductionAuthority } from "../v2/entry/owner-vault-production";
import {
  type OwnerVaultControlOperationResult,
  claimOwnerVaultControlOperation,
  completeOwnerVaultControlOperation,
} from "../v2/owner-vault/control-operation";
import {
  type OwnerVaultSocketAdmissionFault,
  makeOwnerVaultDO,
} from "../v2/owner-vault/owner-vault-do";
import { makeDurableObjectOwnerVaultStorageRepository } from "../v2/owner-vault/repository";

const testReadyPath = "/__owner_vault_do_ready__";
const testOwnerVaultControlPrefix = "/__test/owner-vault-control/";
const testOwnerVaultSocketPath = "/__test/owner-vault-socket";
const c2CapacitySeedPath = "/__test/c2-capacity-seed";
const c2CapacityTracePath = "/__test/c2-capacity-trace";
/** Raw fixture storage only: this name is deliberately outside the v2 registry. */
const c2CapacityTraceStorageKey = "__fixture/c2-capacity-trace-v1";
interface C2CapacityTrace {
  routes: number;
  controlVerify: number;
  manifestKeys: number;
  liveAccess: number;
  restoreStorage: number;
}
interface C2CapacityTraceRecord {
  readonly enabled: true;
  readonly trace: C2CapacityTrace;
}
const c2CapacityTraceZero = (): C2CapacityTrace => ({
  routes: 0,
  controlVerify: 0,
  manifestKeys: 0,
  liveAccess: 0,
  restoreStorage: 0,
});
const resetC2CapacityTrace = (trace: C2CapacityTrace): void => {
  Object.assign(trace, c2CapacityTraceZero());
};
/** One production OwnerVault DO instance backs every relayed route below. */
const testOwnerVault = {
  ownerID: "owner-do-workerd-fixture-0001",
  vaultID: "vault-do-workerd-fixture-0001",
  generationEpoch: 2,
} as const;
/** This selector belongs only to the Workerd relay; both targets use the same
 * production OwnerVaultV2 factory and no test route seeds storage. */
const testOwnerVaultFor = (request: Request) =>
  request.headers.get("x-enchiridion-owner-vault-test-target") === "restore-target"
    ? { ...testOwnerVault, generationEpoch: 3 }
    : request.headers.get("x-enchiridion-owner-vault-test-target") === "capacity-restore-target"
      ? { ...testOwnerVault, generationEpoch: 4 }
      : testOwnerVault;
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};
const ownerVaultSocketAdmissionFault = (
  raw: unknown,
): OwnerVaultSocketAdmissionFault | undefined => {
  const value = record(raw)?.ENCHIRIDION_V2_OWNER_VAULT_SOCKET_TEST_FAULT;
  return value === "accept-failure" ||
    value === "early-callback" ||
    value === "finalize-loss" ||
    value === "prepared-loss"
    ? value
    : undefined;
};
/** This trap is fixture-only: deployable entry composition has no C2 test hook. */
const c2RecoveryAccessTrapEnabled = (raw: unknown): boolean =>
  record(raw)?.ENCHIRIDION_V2_C2_TEST_RECOVERY_ACCESS_TRAP === "enabled";
const c2RecoveryAccessTrap = <A extends object>(authority: A): A =>
  new Proxy(authority, {
    get: () => {
      throw new Error("c2_terminal_recovery_attempted_live_access");
    },
  });
/** Fixture-only trace: method calls, not authority construction, are evidence. */
const c2CapacityRestoreStorageKey = (key: string): boolean =>
  key.includes("/restore/") || key.includes("/restored/");
const c2CapacityTraceTransaction = (
  storage: DurableObjectTransaction,
  trace: C2CapacityTrace,
): DurableObjectTransaction => ({
  ...storage,
  get: (key) => {
    if (c2CapacityRestoreStorageKey(key)) trace.restoreStorage += 1;
    return storage.get(key);
  },
  put: (key, value) => {
    if (c2CapacityRestoreStorageKey(key)) trace.restoreStorage += 1;
    return storage.put(key, value);
  },
  delete: (key) => {
    if (c2CapacityRestoreStorageKey(key)) trace.restoreStorage += 1;
    return storage.delete(key);
  },
});
const c2CapacityTraceStorage = (
  storage: DurableObjectStorage,
  trace: C2CapacityTrace,
): DurableObjectStorage => ({
  ...storage,
  ...c2CapacityTraceTransaction(storage, trace),
  transaction: (work) =>
    storage.transaction((transaction) => work(c2CapacityTraceTransaction(transaction, trace))),
  transactionOutcome: (domainFailure, work) =>
    storage.transactionOutcome(domainFailure, (transaction) =>
      work(c2CapacityTraceTransaction(transaction, trace)),
    ),
});
const c2CapacityTraceBoundary = (
  boundary: DurableObjectBoundary,
  trace: C2CapacityTrace,
): DurableObjectBoundary =>
  Object.freeze({
    storage: c2CapacityTraceStorage(boundary.storage, trace),
    callbacks: boundary.callbacks,
  });
const c2CapacityTraceControls = (
  authority: OwnerVaultDirectoryControlFactory,
  trace: C2CapacityTrace,
): OwnerVaultDirectoryControlFactory =>
  Object.freeze<OwnerVaultDirectoryControlFactory>({
    sign: authority.sign,
    verify: (signed, binding, expected, nowSeconds) => {
      trace.controlVerify += 1;
      return authority.verify(signed, binding, expected, nowSeconds);
    },
  });
const c2CapacityTraceR2Native = <A extends object>(native: A, trace: C2CapacityTrace): A =>
  new Proxy(Object.create(null) as A, {
    get: (_target, property) => {
      const value = Reflect.get(native, property);
      return typeof value === "function"
        ? (...arguments_: readonly unknown[]) => {
            trace.liveAccess += 1;
            return Reflect.apply(value, native, arguments_);
          }
        : value;
    },
  });
const c2CapacityTraceProduction = (
  authority: OwnerVaultProductionAuthority,
  trace: C2CapacityTrace,
): OwnerVaultProductionAuthority =>
  Object.freeze<OwnerVaultProductionAuthority>({
    limits: authority.limits,
    manifestKeys: () => {
      trace.manifestKeys += 1;
      return authority.manifestKeys();
    },
    blobR2: Object.freeze({
      purpose: authority.blobR2.purpose,
      native: c2CapacityTraceR2Native(authority.blobR2.native, trace),
    }),
    backupR2: Object.freeze({
      purpose: authority.backupR2.purpose,
      native: c2CapacityTraceR2Native(authority.backupR2.native, trace),
    }),
  });
type FixtureOwnerVaultPrivateFields = {
  boundary: DurableObjectBoundary;
  ownerVaultControls: OwnerVaultDirectoryControlFactory | undefined;
  production: OwnerVaultProductionAuthority | undefined;
};
const fixtureOwnerVaultPrivateFields = (instance: object): FixtureOwnerVaultPrivateFields =>
  instance as FixtureOwnerVaultPrivateFields;
const replaceFixtureOwnerVaultPrivateField = (
  instance: object,
  field: keyof FixtureOwnerVaultPrivateFields,
  value: FixtureOwnerVaultPrivateFields[typeof field],
): void => {
  const descriptor = Object.getOwnPropertyDescriptor(instance, field);
  if (descriptor?.writable !== true && descriptor?.configurable !== true)
    throw new Error(`fixture OwnerVaultV2 ${field} is not replaceable`);
  Object.defineProperty(instance, field, {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    value,
    writable: descriptor?.writable ?? true,
  });
};
const mergeC2CapacityTrace = (stored: C2CapacityTrace | undefined, trace: C2CapacityTrace) => ({
  routes: (stored?.routes ?? 0) + trace.routes,
  controlVerify: (stored?.controlVerify ?? 0) + trace.controlVerify,
  manifestKeys: (stored?.manifestKeys ?? 0) + trace.manifestKeys,
  liveAccess: (stored?.liveAccess ?? 0) + trace.liveAccess,
  restoreStorage: (stored?.restoreStorage ?? 0) + trace.restoreStorage,
});
const ownerVaultControlPath = (pathname: string): string | undefined => {
  switch (pathname.slice(testOwnerVaultControlPrefix.length)) {
    case "ensure-initialized":
      return ownerVaultInitializationPath;
    case "sync-floors":
      return ownerVaultFloorSyncPath;
    case "private-initialize":
      return "/__v2/internal/owner-vault/private-initialize";
    case "credential-fence":
      return "/__v2/internal/owner-vault/credential-fence";
    case "snapshot":
      return "/__v2/internal/owner-vault/snapshot-receipt-lease-v1";
    case "restore":
      return "/__v2/internal/owner-vault/restore-receipt-lease-v1";
    case "devices/challenge":
      return "/__v2/internal/owner-vault/devices/challenge";
    case "devices/complete":
      return "/__v2/internal/owner-vault/devices/complete";
    case "append":
      return "/__v2/internal/owner-vault/append";
    case "c2-capacity-seed":
      return c2CapacitySeedPath;
    default:
      return undefined;
  }
};

/**
 * Workerd-only relay: test code supplies previously signed, byte-identical
 * control/user wire messages. It exercises the production `OwnerVaultV2`
 * Durable Object and its audited boundary callbacks; no alternate OwnerVault
 * implementation or state seeding path exists here.
 */
const handler = (request: Request, raw: unknown): Effect.Effect<Response> =>
  Effect.try({
    try: () => ({ method: request.method, pathname: new URL(request.url).pathname }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((route) => {
      if (route?.method === "GET" && route.pathname === testReadyPath)
        return Effect.succeed(new Response("ok", { status: 200 }));
      if (
        (route?.method === "GET" || route?.method === "POST" || route?.method === "DELETE") &&
        route.pathname === c2CapacityTracePath
      ) {
        const env = parseVaultV2EntryEnv(raw);
        if (env === undefined) return Effect.succeed(new Response("not found", { status: 404 }));
        const stub = env.OWNER_VAULT_V2_DO.get(
          env.OWNER_VAULT_V2_DO.idFromName(ownerVaultObjectName(testOwnerVaultFor(request))),
        );
        return Effect.tryPromise({
          try: () =>
            stub.fetch(new Request(`https://owner-vault.invalid${c2CapacityTracePath}`, request)),
          catch: () => new Response("unavailable", { status: 503 }),
        });
      }
      if (route?.method === "GET" && route.pathname === testOwnerVaultSocketPath) {
        const env = parseVaultV2EntryEnv(raw);
        if (env === undefined) return Effect.succeed(new Response("not found", { status: 404 }));
        const stub = env.OWNER_VAULT_V2_DO.get(
          env.OWNER_VAULT_V2_DO.idFromName(ownerVaultObjectName(testOwnerVaultFor(request))),
        );
        return Effect.tryPromise({
          try: () =>
            stub.fetch(
              new Request(`https://owner-vault.invalid${ownerVaultSocketAdmissionPath}`, request),
            ),
          catch: () => new Response("unavailable", { status: 503 }),
        });
      }
      if (route?.method === "POST" && route.pathname.startsWith(testOwnerVaultControlPrefix)) {
        const env = parseVaultV2EntryEnv(raw);
        const targetPath = ownerVaultControlPath(route.pathname);
        if (env === undefined || targetPath === undefined)
          return Effect.succeed(new Response("not found", { status: 404 }));
        const stub = env.OWNER_VAULT_V2_DO.get(
          env.OWNER_VAULT_V2_DO.idFromName(ownerVaultObjectName(testOwnerVaultFor(request))),
        );
        return Effect.tryPromise({
          try: () => stub.fetch(new Request(`https://owner-vault.invalid${targetPath}`, request)),
          catch: () => new Response("unavailable", { status: 503 }),
        });
      }
      return Effect.succeed(new Response("not found", { status: 404 }));
    }),
    Effect.catchAll(() => Effect.succeed(new Response("not found", { status: 404 }))),
  );
const boundary = makeWorkerBoundary(handler);
const ownerVaultComposition = makeVaultV2EntryCompositionCache();
/** The fixture owns only dependency injection; it uses the production DO factory. */
const FixtureOwnerVaultV2 = makeOwnerVaultDO((raw) => {
  const resolved = ownerVaultComposition(raw);
  const c2RecoveryTrapEnabled = c2RecoveryAccessTrapEnabled(raw);
  return resolved === undefined
    ? undefined
    : {
        controls: resolved.directoryControls,
        ownerVaultCapabilities: resolved.capabilities,
        ownerVaultControls: c2RecoveryTrapEnabled
          ? c2RecoveryAccessTrap(resolved.ownerVaultDirectoryControls)
          : resolved.ownerVaultDirectoryControls,
        production: c2RecoveryTrapEnabled
          ? c2RecoveryAccessTrap(resolved.ownerVaultProduction)
          : resolved.ownerVaultProduction,
        socketAdmissions: resolved.ownerVaultSocketAdmission,
        socketAdmissionFault: ownerVaultSocketAdmissionFault(raw),
        socketNonce: () =>
          makeP256Crypto()
            .random32()
            .pipe(
              Effect.map((bytes) => base64url(bytes.slice(0, 16))),
              Effect.orDie,
            ),
      };
});
export class OwnerVaultV2 extends FixtureOwnerVaultV2 {
  constructor(ctx: DurableObjectState, env: Readonly<Record<never, never>>) {
    const trace = c2CapacityTraceZero();
    super(ctx, env);
    // Fixture-only post-construction substitution: `makeOwnerVaultDO` has
    // already captured the real production authorities for this exact DO.
    // Counters therefore follow the actual route instance without module
    // globals or deployable-entry hooks.
    const fields = fixtureOwnerVaultPrivateFields(this);
    replaceFixtureOwnerVaultPrivateField(
      this,
      "boundary",
      c2CapacityTraceBoundary(fields.boundary, trace),
    );
    if (fields.ownerVaultControls !== undefined)
      replaceFixtureOwnerVaultPrivateField(
        this,
        "ownerVaultControls",
        c2CapacityTraceControls(fields.ownerVaultControls, trace),
      );
    if (fields.production !== undefined)
      replaceFixtureOwnerVaultPrivateField(
        this,
        "production",
        c2CapacityTraceProduction(fields.production, trace),
      );
    const productionFetch = this.fetch;
    Object.defineProperty(this, "fetch", {
      value: async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === c2CapacityTracePath) {
          if (request.method === "POST") {
            await ctx.storage.put(c2CapacityTraceStorageKey, {
              enabled: true,
              trace: c2CapacityTraceZero(),
            } satisfies C2CapacityTraceRecord);
            return new Response('{"ok":true}', { status: 200 });
          }
          if (request.method === "DELETE") {
            await ctx.storage.delete(c2CapacityTraceStorageKey);
            return new Response('{"ok":true}', { status: 200 });
          }
          const stored = await ctx.storage.get<C2CapacityTraceRecord>(c2CapacityTraceStorageKey);
          return new Response(JSON.stringify(stored?.trace ?? c2CapacityTraceZero()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname !== c2CapacitySeedPath)
          return productionFetch === undefined
            ? new Response('{"ok":false}', { status: 503 })
            : (async () => {
                const tracedRoute =
                  pathname === "/__v2/internal/owner-vault/snapshot-receipt-lease-v1" ||
                  pathname === "/__v2/internal/owner-vault/restore-receipt-lease-v1";
                if (tracedRoute) resetC2CapacityTrace(trace);
                const response = await productionFetch(request);
                const stored =
                  await ctx.storage.get<C2CapacityTraceRecord>(c2CapacityTraceStorageKey);
                if (stored?.enabled === true && tracedRoute) {
                  trace.routes += 1;
                  await ctx.storage.put(c2CapacityTraceStorageKey, {
                    enabled: true,
                    trace: mergeC2CapacityTrace(stored.trace, trace),
                  } satisfies C2CapacityTraceRecord);
                }
                return response;
              })();
        const repository = makeDurableObjectOwnerVaultStorageRepository(
          makeDurableObjectBoundary(ctx).storage,
        );
        const terminal: OwnerVaultControlOperationResult = {
          kind: "restore",
          terminalTranscript: {
            outcome: "COMPLETED",
            restoreID: "c2-capacity-seed-restore",
            manifestDigest: "A".repeat(43),
            inventoryDigest: "B".repeat(43),
            targetCatalogProof: "C".repeat(43),
            accountingProof: "D".repeat(43),
            blobProof: "E".repeat(43),
            finalizationProof: "F".repeat(43),
            appendLogSequence: 0,
            appendLogDigest: "a".repeat(64),
            securityFloor: 1,
            targetRoot: {
              ownerID: testOwnerVault.ownerID,
              vaultID: testOwnerVault.vaultID,
              generationEpoch: 4,
              namespaceState: "PRIVATE",
            },
          },
        };
        const nowSeconds = Math.floor(Date.now() / 1_000);
        return Effect.runPromise(
          Effect.forEach(
            Array.from({ length: 64 }, (_, index) => index + 1),
            (index) => {
              const suffix = String(index).padStart(4, "0");
              const operationID = `c2-capacity-seed-restore-${suffix}`;
              const details = {
                kind: "restore" as const,
                root: {
                  ownerID: testOwnerVault.ownerID,
                  vaultID: testOwnerVault.vaultID,
                  generationEpoch: 4,
                  namespaceState: "PRIVATE" as const,
                },
                operationID,
                receiptJTI: `c2-capacity-seed-jti-${suffix}`,
                lifecycle: "receipt-lease-v1" as const,
                expiresAtSeconds: nowSeconds + 60,
                receiptFingerprint: index.toString(16).padStart(64, "0"),
                controlDigest: (index + 63).toString(16).padStart(64, "0"),
                canonicalCommand: `{"operationID":"${operationID}"}`,
                hardDeadlineMilliseconds: (nowSeconds + 60) * 1_000,
              };
              return claimOwnerVaultControlOperation(
                repository,
                details,
                `c2-capacity-seed-lease-${suffix}`,
              ).pipe(
                Effect.flatMap((claim) =>
                  completeOwnerVaultControlOperation(repository, details, claim.lease, terminal),
                ),
              );
            },
          ),
        ).then(
          () => new Response('{"ok":true}', { status: 200 }),
          () => new Response('{"ok":false}', { status: 403 }),
        );
      },
    });
  }
}
export { CredentialDirectoryDO };

export default {
  fetch: (request: Request, env: unknown, ctx: ExecutionContext) =>
    boundary.handle(request, env, ctx),
};
