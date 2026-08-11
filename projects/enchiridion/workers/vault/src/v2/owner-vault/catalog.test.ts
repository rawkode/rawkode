import { describe, expect, test } from "bun:test";
import {
  ownerVaultCatalogMaximumObjectBytes,
  ownerVaultCatalogMaximumObjects,
  ownerVaultCatalogPages,
  ownerVaultCatalogWithinQuota,
} from "./catalog";

describe("OwnerVault immutable catalog codec", () => {
  test("enforces object and total-object quotas before a root is published", () => {
    expect(ownerVaultCatalogWithinQuota(Array.from({ length: ownerVaultCatalogMaximumObjects }, () => ({ bytes: 1 })))).toBe(true);
    expect(ownerVaultCatalogWithinQuota(Array.from({ length: ownerVaultCatalogMaximumObjects + 1 }, () => ({ bytes: 1 })))).toBe(false);
    expect(ownerVaultCatalogWithinQuota([{ bytes: ownerVaultCatalogMaximumObjectBytes + 1 }])).toBe(false);
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
    expect(pages?.flatMap((page) => page.entries.map((entry) => entry.ordinal))).toEqual(Array.from({ length: 129 }, (_, index) => index));
  });
});
