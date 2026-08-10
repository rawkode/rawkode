import { describe, expect, test } from "bun:test";
import {
  OwnerVaultStorageRegistryError,
  assertOwnerVaultStorageRecord,
  isRestorableOwnerVaultStorageCategory,
  ownerVaultStorageRegistry,
  ownerVaultStorageDefinitionForKey,
} from "./storage-registry";

const registered = (category: Parameters<typeof ownerVaultStorageRegistry.get>[0], identifier?: string) => {
  const definition = ownerVaultStorageRegistry.get(category);
  if (definition === undefined) throw new Error(`missing ${category}`);
  return definition.key(identifier);
};

describe("OwnerVault physical state registry", () => {
  test("is exhaustive and assigns the restore policy matrix", () => {
    expect(ownerVaultStorageRegistry.size).toBe(31);
    const expected = {
      "root.identity": ["exclude", "never"],
      "root.admission": ["exclude", "never"],
      "root.floors": ["exclude", "target-overlay"],
      "root.log-head": ["exclude", "rebuild"],
      "root.runtime": ["exclude", "never"],
      "root.accounting": ["exclude", "rebuild"],
      "catalog.derived": ["exclude", "rebuild"],
      "audit.restore-source": ["audit", "audit-only"],
      device: ["include", "apply"],
      "device-challenge": ["exclude", "never"],
      nonce: ["exclude", "never"],
      jti: ["exclude", "never"],
      "capability-receipt": ["exclude", "never"],
      "operation-receipt": ["include", "apply"],
      "operation-index": ["include", "apply"],
      session: ["exclude", "never"],
      resume: ["exclude", "never"],
      "rate-window": ["exclude", "never"],
      "append-log.entry": ["include", "apply"],
      "append-log.head": ["exclude", "rebuild"],
      "blob.metadata": ["include", "apply"],
      "blob.reference": ["include", "apply"],
      "blob.tombstone": ["include", "apply"],
      "blob.lease": ["exclude", "never"],
      "blob.purge": ["exclude", "never"],
      "backup.pin": ["exclude", "never"],
      "backup.manifest": ["include", "apply"],
      "backup.page": ["include", "apply"],
      "backup.restore-journal": ["exclude", "never"],
      "control.initialization-ack": ["exclude", "never"],
      "control.floor-sync": ["exclude", "never"],
    } as const;
    expect(Object.keys(expected).sort()).toEqual([...ownerVaultStorageRegistry.keys()].sort());
    for (const definition of ownerVaultStorageRegistry.values()) {
      expect(definition.maximumBytes).toBeGreaterThan(0);
      expect([definition.snapshot, definition.restore]).toEqual([...expected[definition.category]]);
      expect(isRestorableOwnerVaultStorageCategory(definition)).toBe(
        definition.snapshot === "include" && definition.restore === "apply",
      );
    }
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
