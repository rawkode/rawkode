import { describe, expect, test } from "bun:test";
import {
  isOwnerVaultCatalogCurrentPayload,
  isOwnerVaultCatalogPagePayload,
  isOwnerVaultCatalogRevisionIdentifier,
  isOwnerVaultCatalogRootPayload,
  ownerVaultCatalogDigest,
  ownerVaultCatalogMaximumObjectBytes,
  ownerVaultCatalogMaximumObjects,
  ownerVaultCatalogMaximumPageEntries,
  ownerVaultCatalogPages,
  ownerVaultCatalogWithinQuota,
} from "./catalog";

const dummyDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const dummyHexDigest = "a".repeat(64);

const descriptor = (ordinal: number, revision = "00000000000000000007") => ({
  ordinal,
  identifier: `${revision}-${String(ordinal).padStart(4, "0")}`,
  count: 1,
  bytes: 100,
  digest: dummyDigest,
});

const rootPayload = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  scope: { ownerID: "owner", vaultID: "vault", generationEpoch: 1, namespaceState: "PRIVATE" },
  catalogRevision: 7,
  catalogDigest: dummyDigest,
  pages: [descriptor(0), descriptor(1)],
  highWaterMark: dummyDigest,
  appendLogSequence: 0,
  appendLogDigest: dummyHexDigest,
  ...overrides,
});

const pageEntry = (ordinal: number) => ({
  ordinal,
  key: `v2.ov/device/${String(ordinal).padStart(3, "0")}`,
  category: "device",
  bytes: 10,
  digest: dummyDigest,
});

describe("OwnerVault immutable catalog codec", () => {
  test("enforces object and total-object quotas before a root is published", () => {
    expect(
      ownerVaultCatalogWithinQuota(
        Array.from({ length: ownerVaultCatalogMaximumObjects }, () => ({ bytes: 1 })),
      ),
    ).toBe(true);
    expect(
      ownerVaultCatalogWithinQuota(
        Array.from({ length: ownerVaultCatalogMaximumObjects + 1 }, () => ({ bytes: 1 })),
      ),
    ).toBe(false);
    expect(ownerVaultCatalogWithinQuota([{ bytes: ownerVaultCatalogMaximumObjectBytes + 1 }])).toBe(
      false,
    );
  });

  test("accepts an exact root payload and rejects malformed catalog revisions", () => {
    expect(isOwnerVaultCatalogRootPayload(rootPayload())).toBe(true);
    expect(isOwnerVaultCatalogRootPayload(rootPayload({ catalogRevision: -1 }))).toBe(false);
    expect(isOwnerVaultCatalogRootPayload(rootPayload({ catalogRevision: 7.5 }))).toBe(false);
    expect(isOwnerVaultCatalogRootPayload(rootPayload({ catalogRevision: "7" }))).toBe(false);
    expect(
      isOwnerVaultCatalogRootPayload(rootPayload({ catalogRevision: "00000000000000000007" })),
    ).toBe(false);
    const { catalogRevision, ...missingRevision } = rootPayload();
    expect(catalogRevision).toBe(7);
    expect(isOwnerVaultCatalogRootPayload(missingRevision)).toBe(false);
  });

  test("binds every page identifier to the root's own catalog revision", () => {
    expect(
      isOwnerVaultCatalogRootPayload(
        rootPayload({ pages: [descriptor(0, "00000000000000000008")] }),
      ),
    ).toBe(false);
    expect(
      isOwnerVaultCatalogRootPayload(
        rootPayload({ pages: [descriptor(0), descriptor(1, "00000000000000000008")] }),
      ),
    ).toBe(false);
  });

  test("rejects duplicate, out-of-order, and overflowing page descriptors", () => {
    expect(
      isOwnerVaultCatalogRootPayload(rootPayload({ pages: [descriptor(0), descriptor(0)] })),
    ).toBe(false);
    expect(
      isOwnerVaultCatalogRootPayload(rootPayload({ pages: [descriptor(1), descriptor(0)] })),
    ).toBe(false);
    const limit = ownerVaultCatalogMaximumObjects / ownerVaultCatalogMaximumPageEntries;
    const dense = (length: number) => Array.from({ length }, (_, index) => descriptor(index));
    expect(isOwnerVaultCatalogRootPayload(rootPayload({ pages: dense(limit) }))).toBe(true);
    expect(isOwnerVaultCatalogRootPayload(rootPayload({ pages: dense(limit + 1) }))).toBe(false);
  });

  test("requires the exact root key set", () => {
    expect(isOwnerVaultCatalogRootPayload({ ...rootPayload(), extra: 1 })).toBe(false);
    const { highWaterMark, ...missingKey } = rootPayload();
    expect(highWaterMark).toBe(dummyDigest);
    expect(isOwnerVaultCatalogRootPayload(missingKey)).toBe(false);
    expect(isOwnerVaultCatalogRootPayload(undefined)).toBe(false);
    expect(isOwnerVaultCatalogRootPayload([])).toBe(false);
  });

  test("verifies page payload digests, dense ordinals, and entry quotas", () => {
    const entries = [pageEntry(3), pageEntry(4)];
    const digest = ownerVaultCatalogDigest(entries);
    expect(digest).toBeDefined();
    expect(isOwnerVaultCatalogPagePayload({ entries, digest })).toBe(true);
    expect(isOwnerVaultCatalogPagePayload({ entries, digest: dummyDigest })).toBe(false);
    expect(
      isOwnerVaultCatalogPagePayload({
        entries: [pageEntry(0), pageEntry(0)],
        digest: dummyDigest,
      }),
    ).toBe(false);
    expect(
      isOwnerVaultCatalogPagePayload({
        entries: [pageEntry(1), pageEntry(0)],
        digest: dummyDigest,
      }),
    ).toBe(false);
    const overflow = Array.from({ length: ownerVaultCatalogMaximumPageEntries + 1 }, (_, index) =>
      pageEntry(index),
    );
    expect(isOwnerVaultCatalogPagePayload({ entries: overflow, digest: dummyDigest })).toBe(false);
    expect(isOwnerVaultCatalogPagePayload({ entries, digest, extra: 1 })).toBe(false);
  });

  test("decodes the current pointer and revision identifiers exactly", () => {
    expect(isOwnerVaultCatalogCurrentPayload({ catalogRevision: 0, rootDigest: dummyDigest })).toBe(
      true,
    );
    expect(
      isOwnerVaultCatalogCurrentPayload({ catalogRevision: -1, rootDigest: dummyDigest }),
    ).toBe(false);
    expect(
      isOwnerVaultCatalogCurrentPayload({ catalogRevision: "0", rootDigest: dummyDigest }),
    ).toBe(false);
    expect(isOwnerVaultCatalogCurrentPayload({ catalogRevision: 0, rootDigest: "short" })).toBe(
      false,
    );
    expect(
      isOwnerVaultCatalogCurrentPayload({ catalogRevision: 0, rootDigest: dummyDigest, extra: 1 }),
    ).toBe(false);
    expect(isOwnerVaultCatalogRevisionIdentifier("00000000000000000007")).toBe(true);
    expect(isOwnerVaultCatalogRevisionIdentifier("7")).toBe(false);
  });

  test("keeps dense ordinals when a target-sized page splits", () => {
    const entries = Array.from({ length: 129 }, (_, index) => ({
      key: `v2.ov/device/${String(index).padStart(3, "0")}`,
      category: "device",
      bytes: 100,
      digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }));
    const pages = ownerVaultCatalogPages(entries);
    expect(pages).toHaveLength(2);
    expect(pages?.flatMap((page) => page.entries.map((entry) => entry.ordinal))).toEqual(
      Array.from({ length: 129 }, (_, index) => index),
    );
  });
});
