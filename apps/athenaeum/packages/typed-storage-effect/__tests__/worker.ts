// Test-only Worker entry for @cloudflare/vitest-pool-workers. Declares one Durable Object class
// purely so tests can get a real `DurableObjectStorage` (via `runInDurableObject`, from
// `cloudflare:test`) to run this package's Effect-wrapped collections/singletons against — not a
// stand-in for the real `WorkspaceDurableObject`/`UserDurableObject`, which belong to the `backend`
// package and are out of scope here (see the task's HARD CONSTRAINTS: this package stays generic,
// with no dependency on `domain` or `backend`).
import { DurableObject } from "cloudflare:workers";

export class TestStorageDurableObject extends DurableObject<Cloudflare.Env> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("not used — tests reach the Durable Object via runInDurableObject()", {
      status: 404,
    });
  },
};
