import { describe, expect, test } from "bun:test";
import { unregisteredOwnerVaultStorageKeys } from "./storage-key-check";

describe("OwnerVault storage-key checker", () => {
  test("rejects a physical storage literal that is absent from the registry", () => {
    expect(unregisteredOwnerVaultStorageKeys('storage.put("v2.ov/forgotten/key", value)')).toEqual([
      "v2.ov/forgotten/key",
    ]);
  });

  test("allows registered literals", () => {
    expect(unregisteredOwnerVaultStorageKeys('storage.get("v2.ov/root/identity")')).toEqual([]);
  });
});
