import { describe, expect, test } from "bun:test";
import { Effect, Exit, Ref } from "effect";
import { credentialID, ownerID, requestID, vaultID } from "../foundation/schemas";
import {
  CanonicalMutationHasher,
  type CanonicalMutationHasher as CanonicalMutationHasherService,
  type MutationCommand,
  MutationKind,
  MutationReceiptRepository,
  canonicalMutationJSON,
  makeInMemoryMutationReceiptRepository,
  makeMutationService,
  maximumMutationReceiptTTLSeconds,
} from "./mutations";

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("invalid test setup");
  return value;
};

const authorization = {
  ownerID: required(ownerID("owner-1")),
  vaultID: required(vaultID("vault-1")),
  generationEpoch: 3,
  credentialID: required(credentialID("credential-1")),
  credentialEpoch: 2,
};
const request = required(requestID("mutation-request-0001"));
const command = (body: MutationCommand["body"], nowSeconds = 100): MutationCommand => ({
  authorization,
  requestID: request,
  kind: MutationKind.PutRecord,
  body,
  nowSeconds,
  receiptExpiresAtSeconds: 200,
});

const hash = (canonicalJSON: string): string =>
  canonicalJSON.includes("second") ? "b".repeat(64) : "a".repeat(64);

const service = async (hasher: CanonicalMutationHasherService) => {
  const repository = await Effect.runPromise(makeInMemoryMutationReceiptRepository);
  const mutationService = await Effect.runPromise(
    makeMutationService.pipe(
      Effect.provideService(MutationReceiptRepository, repository.repository),
      Effect.provideService(CanonicalMutationHasher, hasher),
    ),
  );
  return { ...repository, mutationService };
};

describe("v2 transactional mutations", () => {
  test("uses one canonical hash and returns an exact duplicate re-ACK without applying twice", async () => {
    const seen = await Effect.runPromise(Ref.make<readonly string[]>([]));
    const built = await service({
      hash: (canonicalJSON) =>
        Effect.zipRight(
          Ref.update(seen, (values) => [...values, canonicalJSON]),
          Effect.succeed(hash(canonicalJSON)),
        ),
    });
    const first = await Effect.runPromise(
      built.mutationService.execute(command({ z: "last", a: { value: "first" } })),
    );
    const duplicate = await Effect.runPromise(
      built.mutationService.execute(command({ a: { value: "first" }, z: "last" })),
    );
    expect(first.status).toBe("APPLIED");
    expect(duplicate).toEqual({ ...first, status: "DUPLICATE" });
    expect((await Effect.runPromise(Ref.get(built.state))).version).toBe(1);
    expect(await Effect.runPromise(Ref.get(seen))).toEqual([
      '{"body":{"a":{"value":"first"},"z":"last"},"kind":"PutRecord"}',
      '{"body":{"a":{"value":"first"},"z":"last"},"kind":"PutRecord"}',
    ]);
  });

  test("rejects a reused request ID with a different canonical hash", async () => {
    const built = await service({ hash: (canonicalJSON) => Effect.succeed(hash(canonicalJSON)) });
    await Effect.runPromise(built.mutationService.execute(command({ value: "first" })));
    const exit = await Effect.runPromiseExit(
      built.mutationService.execute(command({ value: "second" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("replay_conflict");
    expect((await Effect.runPromise(Ref.get(built.state))).version).toBe(1);
  });

  test("checks an authenticated replay before applying bounded receipt expiry", async () => {
    const calls = await Effect.runPromise(Ref.make(0));
    const built = await service({
      hash: (canonicalJSON) =>
        Effect.zipRight(
          Ref.update(calls, (value) => value + 1),
          Effect.succeed(hash(canonicalJSON)),
        ),
    });
    await Effect.runPromise(built.mutationService.execute(command({ value: "first" }, 100)));
    const expired = await Effect.runPromiseExit(
      built.mutationService.execute({
        ...command({ value: "first" }, 200),
        receiptExpiresAtSeconds: 201,
      }),
    );
    expect(Exit.isFailure(expired)).toBe(true);
    expect(JSON.stringify(expired)).toContain("expired_receipt");
    expect(await Effect.runPromise(Ref.get(calls))).toBe(2);
  });

  test("uses UTF-16 code-unit key order and rejects an unbounded receipt lifetime", async () => {
    expect(canonicalMutationJSON(command({ "\uE000": "bmp", "\u{1F600}": "surrogate" }))).toContain(
      '"\u{1F600}":"surrogate","\uE000":"bmp"',
    );
    const built = await service({ hash: (canonicalJSON) => Effect.succeed(hash(canonicalJSON)) });
    const tooLong = await Effect.runPromiseExit(
      built.mutationService.execute(command({ value: "first" }, 1)),
    );
    expect(Exit.isFailure(tooLong)).toBe(false);
    const unbounded = await Effect.runPromiseExit(
      built.mutationService.execute({
        ...command({ value: "second" }, 2),
        receiptExpiresAtSeconds: 2 + maximumMutationReceiptTTLSeconds + 1,
      }),
    );
    expect(JSON.stringify(unbounded)).toContain("invalid_command");
  });
});
