import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type OwnerVaultControlTransportError,
  invokeOwnerVaultControl,
  ownerVaultControlMaximumRequestBytes,
  ownerVaultControlMaximumResponseBytes,
} from "./owner-vault-control-client";

const target = { name: "v2-owner-vault-test-shard", path: "/v2/control/ensure-initialized" };

const bytes = (text: string): Uint8Array<ArrayBuffer> => {
  const source = new TextEncoder().encode(text);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
};

const respondingNamespace = (respond: () => Response) => ({
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({ fetch: async () => respond() }),
});

const failed = (
  effect: Effect.Effect<unknown, OwnerVaultControlTransportError>,
): Promise<OwnerVaultControlTransportError> => Effect.runPromise(Effect.flip(effect));

test("returns exact-parsed JSON from a conforming control response", async () => {
  const namespace = respondingNamespace(() => new Response(JSON.stringify({ ok: true, value: 7 })));
  const decoded = await Effect.runPromise(
    invokeOwnerVaultControl(namespace, target, bytes('{"command":{}}')),
  );
  expect(decoded).toEqual({ ok: true, value: 7 });
});

test("rejects targets that carry a query, fragment, or unknown path shape", async () => {
  const namespace = respondingNamespace(() => new Response("{}"));
  for (const path of [
    "/v2/control/ensure-initialized?admin=1",
    "/v2/control/ensure-initialized#x",
    "/v2/control/Ensure-Initialized",
    "/v2/other/ensure-initialized",
    "v2/control/ensure-initialized",
    "/v2/control/",
  ]) {
    const error = await failed(
      invokeOwnerVaultControl(namespace, { ...target, path }, bytes("{}")),
    );
    expect(error.reason).toBe("invalid_request");
  }
});

test("rejects empty, oversized, and never sends invalid request bodies", async () => {
  let fetched = 0;
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async () => {
        fetched += 1;
        return new Response("{}");
      },
    }),
  };
  const empty = await failed(invokeOwnerVaultControl(namespace, target, new Uint8Array(0)));
  expect(empty.reason).toBe("invalid_request");
  const oversized = await failed(
    invokeOwnerVaultControl(
      namespace,
      target,
      new Uint8Array(ownerVaultControlMaximumRequestBytes + 1),
    ),
  );
  expect(oversized.reason).toBe("invalid_request");
  const badName = await failed(
    invokeOwnerVaultControl(namespace, { ...target, name: "bad name!" }, bytes("{}")),
  );
  expect(badName.reason).toBe("invalid_request");
  expect(fetched).toBe(0);
});

test("caps response bytes and rejects oversized bodies", async () => {
  const namespace = respondingNamespace(
    () => new Response(`{"padding":"${"x".repeat(ownerVaultControlMaximumResponseBytes + 1)}"}`),
  );
  const error = await failed(invokeOwnerVaultControl(namespace, target, bytes("{}")));
  expect(error.reason).toBe("response_rejected");
});

test("rejects unexpected statuses as unavailable", async () => {
  const namespace = respondingNamespace(() => new Response("{}", { status: 500 }));
  const error = await failed(invokeOwnerVaultControl(namespace, target, bytes("{}")));
  expect(error.reason).toBe("unavailable");
});

test("rejects malformed, duplicate-member, and non-UTF-8 response JSON", async () => {
  for (const payload of ["not-json", '{"a":1,"a":2}'] as const) {
    const namespace = respondingNamespace(() => new Response(payload));
    const error = await failed(invokeOwnerVaultControl(namespace, target, bytes("{}")));
    expect(error.reason).toBe("response_rejected");
  }
  const invalidUTF8 = respondingNamespace(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d])));
  const error = await failed(invokeOwnerVaultControl(invalidUTF8, target, bytes("{}")));
  expect(error.reason).toBe("response_rejected");
});

test("surfaces namespace failures as unavailable", async () => {
  const namespace = {
    idFromName: () => {
      throw new Error("no shard");
    },
    get: () => ({ fetch: async () => new Response("{}") }),
  };
  const error = await failed(invokeOwnerVaultControl(namespace, target, bytes("{}")));
  expect(error.reason).toBe("unavailable");
});
