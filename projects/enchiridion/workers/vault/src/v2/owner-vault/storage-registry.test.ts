import { describe, expect, test } from "bun:test";
import {
  OwnerVaultStorageRegistryError,
  assertOwnerVaultStorageRecord,
  ownerVaultStorageRegistry,
  ownerVaultStorageDefinitionForKey,
} from "./storage-registry";

const registered = (category: Parameters<typeof ownerVaultStorageRegistry.get>[0], identifier?: string) => {
  const definition = ownerVaultStorageRegistry.get(category);
  if (definition === undefined) throw new Error(`missing ${category}`);
  return definition.key(identifier);
};

describe("OwnerVault physical state registry", () => {
  test("is exhaustive and assigns an explicit snapshot/restore policy to each category", () => {
    expect(ownerVaultStorageRegistry.size).toBe(31);
    for (const definition of ownerVaultStorageRegistry.values()) {
      expect(definition.maximumBytes).toBeGreaterThan(0);
      expect(definition.snapshot).toBeDefined();
      expect(definition.restore).toBeDefined();
    }
    expect(ownerVaultStorageRegistry.get("root.admission")?.restore).toBe("never");
    expect(ownerVaultStorageRegistry.get("root.floors")?.restore).toBe("target-overlay");
    expect(ownerVaultStorageRegistry.get("audit.restore-source")?.restore).toBe("audit-only");
  });

  test("rejects unknown physical keys and any authoritative scope outside root identity", () => {
    expect(() => ownerVaultStorageDefinitionForKey("v2.ov/unregistered/key")).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => registered("append-log.entry", "1")).toThrow(OwnerVaultStorageRegistryError);
    expect(assertOwnerVaultStorageRecord(registered("root.identity"), {
      category: "root.identity", version: 1, payload: { ownerID: "owner", vaultID: "vault", generationEpoch: 2 },
    })).toMatchObject({ category: "root.identity" });
    expect(() => assertOwnerVaultStorageRecord(registered("device", "device_1"), {
      category: "device", version: 1, payload: { ownerID: "owner" },
    })).toThrow(OwnerVaultStorageRegistryError);
  });

  test("permits source scope solely inside the audit restore-source record", () => {
    expect(assertOwnerVaultStorageRecord(registered("audit.restore-source"), {
      category: "audit.restore-source", version: 1,
      payload: { source: { ownerID: "source", vaultID: "vault", generationEpoch: 1 }, audit: { reason: "restore" } },
    })).toMatchObject({ category: "audit.restore-source" });
    expect(() => assertOwnerVaultStorageRecord(registered("audit.restore-source"), {
      category: "audit.restore-source", version: 1,
      payload: { source: { ownerID: "source", vaultID: "vault", generationEpoch: 1 }, audit: { ownerID: "no" } },
    })).toThrow(OwnerVaultStorageRegistryError);
  });
});
