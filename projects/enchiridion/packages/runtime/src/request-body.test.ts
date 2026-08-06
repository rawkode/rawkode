import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { readBoundedRequestBody } from "./index";

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values);

const requestFor = (
  body: ReadableStream<Uint8Array> | null,
  headers: Headers = new Headers(),
): Request => ({ method: "POST", bodyUsed: false, body, headers }) as Request;

const stream = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

describe("bounded Worker request-body adapter", () => {
  test("copies a bounded request body after strict header validation", async () => {
    const source = bytes(1, 2, 3);
    const effect = readBoundedRequestBody(
      requestFor(
        stream(source),
        new Headers({ "content-length": "3", "content-type": "application/cbor" }),
      ),
      { maximumBytes: 3, requiredContentType: "application/cbor", requireContentLength: true },
    );
    const output = await Effect.runPromise(effect);
    source[0] = 99;
    expect(Array.from(output)).toEqual([1, 2, 3]);
    output[0] = 88;
    expect(source[0]).toBe(99);
  });

  test("fails closed for unavailable, malformed, missing, and duplicate-combined lengths", async () => {
    const unavailable = await Effect.runPromiseExit(
      readBoundedRequestBody(requestFor(null), { maximumBytes: 1 }),
    );
    expect(JSON.stringify(unavailable)).toContain("body_unavailable");
    const alreadyUsed = await Effect.runPromiseExit(
      readBoundedRequestBody(
        {
          method: "POST",
          bodyUsed: true,
          body: stream(bytes()),
          headers: new Headers(),
        } as Request,
        { maximumBytes: 1 },
      ),
    );
    expect(JSON.stringify(alreadyUsed)).toContain("body_unavailable");
    for (const contentLength of [undefined, "3, 3", "03", "-1", "9007199254740992"]) {
      const headers = new Headers();
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const exit = await Effect.runPromiseExit(
        readBoundedRequestBody(requestFor(stream(bytes()), headers), {
          maximumBytes: 3,
          requireContentLength: true,
        }),
      );
      expect(JSON.stringify(exit)).toContain(
        contentLength === undefined ? "content_length_required" : "content_length_invalid",
      );
    }
  });

  test("rejects hostile Content-Length values without coercion or secret leakage", async () => {
    const hostileRequest = {
      method: "POST",
      bodyUsed: false,
      body: stream(bytes()),
      headers: {
        get: (name: string): unknown =>
          name === "content-length"
            ? {
                [Symbol.toPrimitive]: () => {
                  throw new Error("content-length-secret");
                },
              }
            : null,
      },
    } as Request;
    const exit = await Effect.runPromiseExit(
      readBoundedRequestBody(hostileRequest, { maximumBytes: 3, requireContentLength: true }),
    );
    expect(JSON.stringify(exit)).toContain("content_length_invalid");
    expect(JSON.stringify(exit)).not.toContain("content-length-secret");
  });

  test("requires actual stream bytes to exactly match declared Content-Length", async () => {
    const short = await Effect.runPromiseExit(
      readBoundedRequestBody(
        requestFor(stream(bytes(1), bytes(2)), new Headers({ "content-length": "3" })),
        { maximumBytes: 3, requireContentLength: true },
      ),
    );
    expect(JSON.stringify(short)).toContain("content_length_mismatch");

    const long = await Effect.runPromiseExit(
      readBoundedRequestBody(
        requestFor(stream(bytes(1), bytes(2), bytes(3)), new Headers({ "content-length": "2" })),
        { maximumBytes: 3, requireContentLength: true },
      ),
    );
    expect(JSON.stringify(long)).toContain("content_length_mismatch");

    const overflowing = await Effect.runPromiseExit(
      readBoundedRequestBody(
        requestFor(stream(bytes(1, 2, 3, 4)), new Headers({ "content-length": "3" })),
        { maximumBytes: 3, requireContentLength: true },
      ),
    );
    expect(JSON.stringify(overflowing)).toContain("body_too_large");
  });

  test("bounds declared and chunked payloads and preserves overflow despite cancel rejection", async () => {
    const declared = await Effect.runPromiseExit(
      readBoundedRequestBody(requestFor(stream(bytes(1)), new Headers({ "content-length": "4" })), {
        maximumBytes: 3,
      }),
    );
    expect(JSON.stringify(declared)).toContain("body_too_large");

    const cancelRejecting = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(bytes(1, 2, 3, 4)),
      cancel: () => Promise.reject(new Error("cancel-secret")),
    });
    const chunked = await Effect.runPromiseExit(
      readBoundedRequestBody(requestFor(cancelRejecting), { maximumBytes: 3 }),
    );
    expect(JSON.stringify(chunked)).toContain("body_too_large");
    expect(JSON.stringify(chunked)).not.toContain("cancel-secret");
  });

  test("contains hostile Request getters and enforces content type", async () => {
    const hostile = Object.defineProperty({}, "method", {
      get: () => {
        throw new Error("request-secret");
      },
    }) as Request;
    const hostileExit = await Effect.runPromiseExit(
      readBoundedRequestBody(hostile, { maximumBytes: 3 }),
    );
    expect(JSON.stringify(hostileExit)).toContain("request_malformed");
    expect(JSON.stringify(hostileExit)).not.toContain("request-secret");

    const malformedMethod = await Effect.runPromiseExit(
      readBoundedRequestBody(
        {
          method: "post",
          bodyUsed: false,
          body: stream(bytes()),
          headers: new Headers(),
        } as Request,
        { maximumBytes: 3 },
      ),
    );
    expect(JSON.stringify(malformedMethod)).toContain("request_malformed");

    const typeExit = await Effect.runPromiseExit(
      readBoundedRequestBody(
        requestFor(stream(bytes()), new Headers({ "content-type": "text/plain" })),
        { maximumBytes: 3, requiredContentType: "application/cbor" },
      ),
    );
    expect(JSON.stringify(typeExit)).toContain("content_type_invalid");
  });

  test("claims a reusable Effect once under concurrent execution", async () => {
    const effect = readBoundedRequestBody(requestFor(stream(bytes(1))), { maximumBytes: 1 });
    const exits = await Effect.runPromise(
      Effect.all([Effect.exit(effect), Effect.exit(effect)], { concurrency: "unbounded" }),
    );
    expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(exits.filter(Exit.isFailure).map((exit) => JSON.stringify(exit))).toEqual(
      expect.arrayContaining([expect.stringContaining("body_already_claimed")]),
    );
  });
});
