// @enchiridion/worker-gadget-host — turns a `GadgetDefinition` row (either
// of `gadget-definition-store.ts`'s two shapes) into the `Record<string,
// string>` `env.GADGET_LOADER.get(id, callback)`'s callback needs to return
// as `WorkerLoaderWorkerCode.modules` (`gadget-supervisor-do.ts`'s
// `invokeGadget`/`debugInvokeGadgetWithEmptyEnv`).
//
// PURE, R2-RUNTIME-AGNOSTIC ON PURPOSE: takes an `R2LikeBucket` — a
// minimal structural interface (`.get(key)` returning something with
// `.text()`, exactly the slice of `@cloudflare/workers-types`' real
// `R2Bucket`/`R2ObjectBody` this file needs) rather than importing
// `R2Bucket` directly, mirroring `workers/gatekeeper-google/src/
// r2-types.ts`'s established "narrow structural R2 interface, real
// `R2Bucket` satisfies it for free" convention (see that file's header —
// same reasoning, not restated). This keeps the function fully unit-
// testable under `bun test` with a plain in-memory fake bucket, no
// `cloudflare:workers`/Workers-runtime dependency at all — same
// "DO-runtime-independent plain module" split every other real-logic
// module in this worker uses.

export interface R2LikeObjectBody {
  text(): Promise<string>;
}

export interface R2LikeBucket {
  get(key: string): Promise<R2LikeObjectBody | null>;
}

/** The minimal slice of `GadgetDefinition` this function actually reads —
 *  kept structural (not imported from `gadget-definition-store.ts`) so
 *  this file has no compile-time dependency on that module's full type,
 *  matching this worker's established "narrow local type at the point a
 *  cross-module boundary is crossed" convention (compare `vault-accessor-
 *  client.ts`'s/`gatekeeper-calendar-client.ts`'s header comments). */
export interface GadgetCodeSource {
  mainModule: string;
  modules: Record<string, string> | null;
  r2Key: string | null;
}

export class GadgetCodeNotFoundError extends Error {
  constructor(
    public readonly r2Key: string,
  ) {
    super(`gadget code not found in R2 for key "${r2Key}"`);
    this.name = "GadgetCodeNotFoundError";
  }
}

/** Resolves either storage shape to the `modules` map the Worker Loader
 *  needs. R2-backed sources are fetched as a SINGLE text object and placed
 *  under `mainModule`'s own key (this pass's gadgets — see
 *  `gadgets/morning-brief/`'s deploy script — are bundled to one
 *  self-contained JS file before upload for exactly this reason: no
 *  multi-module R2 manifest format is needed yet). Throws
 *  `GadgetCodeNotFoundError` if `r2Key` is set but the object is missing
 *  (a gadget whose code was deleted out from under a still-registered
 *  definition must fail loudly, not silently load empty/stale code), and a
 *  plain `TypeError` if a definition has neither shape set (should be
 *  unreachable given `upsertGadgetDefinition`'s own "exactly one" guard,
 *  but this function fails closed rather than assuming that invariant
 *  holds by construction forever). */
export async function resolveGadgetModules(bucket: R2LikeBucket, definition: GadgetCodeSource): Promise<Record<string, string>> {
  if (definition.r2Key) {
    const object = await bucket.get(definition.r2Key);
    if (!object) {
      throw new GadgetCodeNotFoundError(definition.r2Key);
    }
    const source = await object.text();
    return { [definition.mainModule]: source };
  }
  if (definition.modules) {
    return definition.modules;
  }
  throw new TypeError(`gadget definition for main module "${definition.mainModule}" has neither inline modules nor an r2Key — cannot load code`);
}
