import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  DurableObjectInvocationError,
  type DurableObjectNamespaceNative,
  makeFixedDurableObjectClient,
} from "./index";

const configuration = {
  name: "directory-v1",
  method: "POST" as const,
  path: "/internal/directory",
  headers: { "content-type": "application/octet-stream" },
  expectedStatus: 200,
  maximumRequestBytes: 32,
  maximumResponseBytes: 16,
};

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values);

const namespaceFor = (
  fetch: (request: Request) => Promise<Response>,
  seenNames: string[] = [],
): DurableObjectNamespaceNative => ({
  idFromName: (name) => {
    seenNames.push(name);
    return { toString: () => `id:${name}` };
  },
  get: () => ({ fetch }),
});

describe("fixed Durable Object HTTP client", () => {
  test("uses only its fixed name and copies bounded request and response bytes", async () => {
    const names: string[] = [];
    let request: Request | undefined;
    const responseSource = bytes(4, 5, 6);
    const client = makeFixedDurableObjectClient(
      namespaceFor((received) => {
        request = received;
        return Promise.resolve(new Response(responseSource, { status: 200 }));
      }, names),
      configuration,
    );
    const input = bytes(1, 2, 3);
    const output = await Effect.runPromise(client.invoke(input));
    input[0] = 99;
    responseSource[0] = 99;

    expect(names).toEqual(["directory-v1"]);
    expect(request?.url).toBe("https://durable-object.invalid/internal/directory");
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("error");
    expect(request?.headers.get("content-type")).toBe("application/octet-stream");
    if (request === undefined) throw new Error("expected Durable Object request");
    expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(Array.from(output.body)).toEqual([4, 5, 6]);
    output.body[0] = 88;
    expect(responseSource[0]).toBe(99);
  });

  test("closes namespace and stub secrets", async () => {
    const namespace: DurableObjectNamespaceNative = {
      idFromName: () => {
        throw new Error("namespace-secret");
      },
      get: () => ({ fetch: () => Promise.reject(new Error("unreachable")) }),
    };
    const namespaceExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(namespace, configuration).invoke(bytes()),
    );
    expect(Exit.isFailure(namespaceExit)).toBe(true);
    expect(JSON.stringify(namespaceExit)).toContain("namespace_failed");
    expect(JSON.stringify(namespaceExit)).not.toContain("namespace-secret");

    const creationExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        {
          idFromName: () => ({ toString: () => "directory" }),
          get: () => {
            throw new Error("stub-creation-secret");
          },
        },
        configuration,
      ).invoke(bytes()),
    );
    expect(Exit.isFailure(creationExit)).toBe(true);
    expect(JSON.stringify(creationExit)).toContain("stub_failed");
    expect(JSON.stringify(creationExit)).not.toContain("stub-creation-secret");

    const stubExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.reject(new Error("stub-secret"))),
        configuration,
      ).invoke(bytes()),
    );
    expect(Exit.isFailure(stubExit)).toBe(true);
    expect(JSON.stringify(stubExit)).toContain("stub_failed");
    expect(JSON.stringify(stubExit)).not.toContain("stub-secret");
  });

  test("rejects malformed, oversized, and unexpected responses without exposing bytes", async () => {
    const malformed = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve({} as Response)),
        configuration,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(malformed)).toContain("response_malformed");

    const throwingResponse = Object.defineProperties(
      {},
      {
        status: {
          get: () => {
            throw new Error("response-getter-secret");
          },
        },
      },
    );
    const throwingExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve(throwingResponse as Response)),
        configuration,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(throwingExit)).toContain("response_malformed");
    expect(JSON.stringify(throwingExit)).not.toContain("response-getter-secret");

    const oversized = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() =>
          Promise.resolve(new Response(bytes(...Array(17).fill(7)), { status: 200 })),
        ),
        configuration,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(oversized)).toContain("response_too_large");

    const cancelRejecting = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytes(...Array(17).fill(7))),
      cancel: () => Promise.reject(new Error("cancel-secret")),
    });
    const cancelExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve(new Response(cancelRejecting, { status: 200 }))),
        configuration,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(cancelExit)).toContain("response_too_large");
    expect(JSON.stringify(cancelExit)).not.toContain("cancel-secret");

    const status = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve(new Response("secret-body", { status: 409 }))),
        configuration,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(status)).toContain("unexpected_status");
    expect(JSON.stringify(status)).not.toContain("secret-body");
  });

  test("preserves one closed result per concurrent invocation", async () => {
    let invocation = 0;
    const client = makeFixedDurableObjectClient(
      namespaceFor(() => {
        invocation += 1;
        return Promise.resolve(new Response(bytes(invocation), { status: 200 }));
      }),
      configuration,
    );
    const results = await Effect.runPromise(
      Effect.all([client.invoke(bytes(1)), client.invoke(bytes(2)), client.invoke(bytes(3))], {
        concurrency: "unbounded",
      }),
    );
    expect(invocation).toBe(3);
    expect(results.map((result) => result.body[0]).sort()).toEqual([1, 2, 3]);
  });

  test("fails invalid static configuration before native invocation", async () => {
    let invoked = false;
    const exit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => {
          invoked = true;
          return Promise.resolve(new Response(null, { status: 200 }));
        }),
        { ...configuration, path: "https://other.example" },
      ).invoke(bytes()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain(DurableObjectInvocationError.name);
    expect(JSON.stringify(exit)).toContain("invalid_configuration");
    expect(invoked).toBe(false);
  });

  test("rejects noncanonical paths, duplicate folded headers, and hostile configuration getters", async () => {
    const invalidPaths = [
      "/safe/../other",
      "/safe/%2e%2e/other",
      "/safe/%2E%2E/other",
      "/safe/%2Fother",
      "/safe/%2fother",
      "/safe/%5cother",
      "/safe/%5Cother",
      "/safe/%zz",
      "/safe/%41",
      "/safe/%7e",
    ];
    for (const path of invalidPaths) {
      const exit = await Effect.runPromiseExit(
        makeFixedDurableObjectClient(
          namespaceFor(() => Promise.resolve(new Response(null, { status: 200 }))),
          { ...configuration, path },
        ).invoke(bytes()),
      );
      expect(JSON.stringify(exit)).toContain("invalid_configuration");
    }
    const duplicateExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve(new Response(null, { status: 200 }))),
        { ...configuration, headers: { "x-test": "one", "X-Test": "two" } },
      ).invoke(bytes()),
    );
    expect(JSON.stringify(duplicateExit)).toContain("invalid_configuration");

    const hostile = new Proxy(configuration, {
      get: (_target, property) => {
        if (property === "name") throw new Error("configuration-getter-secret");
        return Reflect.get(_target, property);
      },
    });
    const hostileExit = await Effect.runPromiseExit(
      makeFixedDurableObjectClient(
        namespaceFor(() => Promise.resolve(new Response(null, { status: 200 }))),
        hostile,
      ).invoke(bytes()),
    );
    expect(JSON.stringify(hostileExit)).toContain("invalid_configuration");
    expect(JSON.stringify(hostileExit)).not.toContain("configuration-getter-secret");
  });

  test("snapshots mutable configuration before exposing the client", async () => {
    const names: string[] = [];
    const mutable = {
      ...configuration,
      headers: { ...configuration.headers },
    };
    const client = makeFixedDurableObjectClient(
      namespaceFor(() => Promise.resolve(new Response(null, { status: 200 })), names),
      mutable,
    );
    mutable.name = "attacker-selected";
    mutable.path = "/attacker-selected";
    mutable.headers["content-type"] = "attacker-selected";
    await Effect.runPromise(client.invoke(bytes()));
    expect(names).toEqual(["directory-v1"]);
  });
});
