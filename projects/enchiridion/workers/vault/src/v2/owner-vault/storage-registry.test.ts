import { describe, expect, test } from "bun:test";
import {
  OwnerVaultStorageRegistryError,
  assertOwnerVaultStorageRecord,
  isRestorableOwnerVaultStorageCategory,
  ownerVaultStorageDefinitionForKey,
  ownerVaultStorageRegistry,
} from "./storage-registry";

const registered = (
  category: Parameters<typeof ownerVaultStorageRegistry.get>[0],
  identifier?: string,
) => {
  const definition = ownerVaultStorageRegistry.get(category);
  if (definition === undefined) throw new Error(`missing ${category}`);
  return definition.key(identifier);
};

describe("OwnerVault physical state registry", () => {
  test("is exhaustive and assigns the restore policy matrix", () => {
    expect(ownerVaultStorageRegistry.size).toBe(40);
    const expected = {
      "root.identity": ["exclude", "never"],
      "root.admission": ["exclude", "never"],
      "root.floors": ["exclude", "target-overlay"],
      "root.log-head": ["exclude", "rebuild"],
      "root.runtime": ["exclude", "never"],
      "root.accounting": ["exclude", "rebuild"],
      "catalog.current": ["exclude", "rebuild"],
      "catalog.root": ["exclude", "rebuild"],
      "catalog.page": ["exclude", "rebuild"],
      "catalog.retention": ["exclude", "never"],
      "audit.restore-source": ["audit", "audit-only"],
      device: ["include", "apply"],
      "device-challenge": ["exclude", "never"],
      nonce: ["exclude", "never"],
      jti: ["exclude", "never"],
      "capability-receipt": ["exclude", "never"],
      "capability-receipt-index": ["exclude", "never"],
      "operation-receipt": ["include", "apply"],
      "operation-index": ["include", "apply"],
      session: ["exclude", "never"],
      resume: ["exclude", "never"],
      "rate-window": ["exclude", "never"],
      "append-log.entry": ["include", "apply"],
      "append-log.head": ["exclude", "rebuild"],
      "blob.accounting": ["exclude", "rebuild"],
      "blob.metadata": ["include", "apply"],
      "blob.reference": ["include", "apply"],
      "blob.tombstone": ["include", "apply"],
      "blob.lease": ["exclude", "never"],
      "blob.purge": ["exclude", "never"],
      "backup.pin": ["exclude", "never"],
      "backup.preimage": ["exclude", "never"],
      "backup.gc-journal": ["exclude", "never"],
      "backup.manifest": ["include", "apply"],
      "backup.page": ["include", "apply"],
      "backup.restore-journal": ["exclude", "never"],
      "socket.admission": ["exclude", "never"],
      "socket.jti": ["exclude", "never"],
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

  test("requires the exact target root and rejects its authority fields outside root identity", () => {
    expect(() => ownerVaultStorageDefinitionForKey("v2.ov/unregistered/key")).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => registered("append-log.entry", "1")).toThrow(OwnerVaultStorageRegistryError);
    expect(
      assertOwnerVaultStorageRecord(registered("root.identity"), {
        category: "root.identity",
        version: 1,
        payload: {
          ownerID: "owner",
          vaultID: "vault",
          generationEpoch: 2,
          namespaceState: "PRIVATE",
        },
      }),
    ).toMatchObject({ category: "root.identity" });
    expect(() =>
      assertOwnerVaultStorageRecord(registered("root.identity"), {
        category: "root.identity",
        version: 1,
        payload: {
          ownerID: "owner",
          vaultID: "vault",
          generationEpoch: 0,
          namespaceState: "PRIVATE",
        },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
    expect(() =>
      assertOwnerVaultStorageRecord(registered("device", "device_1"), {
        category: "device",
        version: 1,
        payload: { namespaceState: "ACTIVE" },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
    expect(
      assertOwnerVaultStorageRecord(registered("root.floors"), {
        category: "root.floors",
        version: 1,
        payload: { securityFloor: 0 },
      }),
    ).toMatchObject({ category: "root.floors" });
    expect(() =>
      assertOwnerVaultStorageRecord(registered("root.floors"), {
        category: "root.floors",
        version: 1,
        payload: { generation: 1, securityFloor: 0 },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
  });

  test("keeps the capability expiry cursor in one bounded local-only singleton", () => {
    expect(
      assertOwnerVaultStorageRecord(registered("capability-receipt-index"), {
        category: "capability-receipt-index",
        version: 1,
        payload: {
          cursor: 0,
          entries: [{ jti: "capability-jti-0001", expiresAtSeconds: 10 }],
        },
      }),
    ).toMatchObject({ category: "capability-receipt-index" });
    expect(() =>
      assertOwnerVaultStorageRecord(registered("capability-receipt-index"), {
        category: "capability-receipt-index",
        version: 1,
        payload: {
          cursor: 0,
          entries: [
            { jti: "capability-jti-0002", expiresAtSeconds: 10 },
            { jti: "capability-jti-0001", expiresAtSeconds: 10 },
          ],
        },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
  });

  test("gives blob lifecycle accounting its own exact, rebuildable singleton", () => {
    expect(registered("blob.accounting")).toBe("v2.ov/blob/accounting");
    expect(
      assertOwnerVaultStorageRecord(registered("blob.accounting"), {
        category: "blob.accounting",
        version: 1,
        payload: {
          referencedBytes: 0,
          reservedStageBytes: 0,
          prospectiveFinalBytes: 0,
          leaseIDs: [],
          purgeSHA256s: [],
        },
      }),
    ).toMatchObject({ category: "blob.accounting" });
    expect(() =>
      assertOwnerVaultStorageRecord(registered("blob.accounting"), {
        category: "blob.accounting",
        version: 1,
        payload: {
          referencedBytes: 0,
          reservedStageBytes: 0,
          prospectiveFinalBytes: 0,
          leaseIDs: [],
          purgeSHA256s: [],
          ownerID: "wrong",
        },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
  });

  test("decodes socket admission phases as an exact closed domain", () => {
    const admission = (overrides: Readonly<Record<string, unknown>> = {}) => ({
      category: "socket.admission",
      version: 1,
      payload: {
        acceptedAtMilliseconds: 0,
        bindingNonce: "A".repeat(22),
        challenge: {
          challengeID: "challenge-1",
          challengeBase64: "B".repeat(22),
          challengeAudience: "owner-vault-socket",
        },
        controlEpoch: 1,
        createdAtMilliseconds: 1_000,
        credentialEpoch: 1,
        deviceID: "device-1",
        expiresAtMilliseconds: 2_000_000,
        expiresAtSeconds: 2_000,
        fingerprint: "a".repeat(64),
        generationEpoch: 1,
        issuedAtSeconds: 1,
        jti: "C".repeat(16),
        namespaceState: "PRIVATE",
        operationID: "D".repeat(16),
        ownerID: "owner-1",
        phase: "PREPARED",
        quotaReserved: false,
        routingEpoch: 1,
        securityFloor: 1,
        sessionID: "session-1",
        socketGeneration: 1,
        upgradeNonce: "E".repeat(22),
        vaultID: "vault-1",
        ...overrides,
      },
    });
    const key = registered("socket.admission", "admission-1");
    expect(assertOwnerVaultStorageRecord(key, admission())).toMatchObject({
      category: "socket.admission",
    });
    expect(
      assertOwnerVaultStorageRecord(
        key,
        admission({ phase: "ACCEPTED", acceptedAtMilliseconds: 1_500 }),
      ),
    ).toMatchObject({ category: "socket.admission" });
    expect(() => assertOwnerVaultStorageRecord(key, admission({ phase: "BOGUS" }))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission({ phase: "prepared" }))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission({ phase: 1 }))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission({ phase: undefined }))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    const { phase, ...withoutPhase } = admission().payload;
    expect(phase).toBe("PREPARED");
    expect(() =>
      assertOwnerVaultStorageRecord(key, {
        category: "socket.admission",
        version: 1,
        payload: withoutPhase,
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
  });

  test("keeps acceptance milliseconds cross-checked against the admission phase", () => {
    const admission = (phase: string, acceptedAtMilliseconds: number) => ({
      category: "socket.admission",
      version: 1,
      payload: {
        acceptedAtMilliseconds,
        bindingNonce: "A".repeat(22),
        challenge: {
          challengeID: "challenge-1",
          challengeBase64: "B".repeat(22),
          challengeAudience: "owner-vault-socket",
        },
        controlEpoch: 1,
        createdAtMilliseconds: 1_000,
        credentialEpoch: 1,
        deviceID: "device-1",
        expiresAtMilliseconds: 2_000_000,
        expiresAtSeconds: 2_000,
        fingerprint: "a".repeat(64),
        generationEpoch: 1,
        issuedAtSeconds: 1,
        jti: "C".repeat(16),
        namespaceState: "PRIVATE",
        operationID: "D".repeat(16),
        ownerID: "owner-1",
        phase,
        quotaReserved: false,
        routingEpoch: 1,
        securityFloor: 1,
        sessionID: "session-1",
        socketGeneration: 1,
        upgradeNonce: "E".repeat(22),
        vaultID: "vault-1",
      },
    });
    const key = registered("socket.admission", "admission-2");
    expect(assertOwnerVaultStorageRecord(key, admission("EXPIRED", 0))).toMatchObject({
      category: "socket.admission",
    });
    expect(assertOwnerVaultStorageRecord(key, admission("CLOSED", 1_000))).toMatchObject({
      category: "socket.admission",
    });
    expect(() => assertOwnerVaultStorageRecord(key, admission("PREPARED", 1_500))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission("EXPIRED", 1_500))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission("ACCEPTED", 500))).toThrow(
      OwnerVaultStorageRegistryError,
    );
    expect(() => assertOwnerVaultStorageRecord(key, admission("ACCEPTED", 0))).toThrow(
      OwnerVaultStorageRegistryError,
    );
  });

  test("permits source scope solely inside the audit restore-source record", () => {
    expect(
      assertOwnerVaultStorageRecord(registered("audit.restore-source"), {
        category: "audit.restore-source",
        version: 1,
        payload: {
          source: { ownerID: "source", vaultID: "vault", generationEpoch: 1 },
          audit: { reason: "restore" },
        },
      }),
    ).toMatchObject({ category: "audit.restore-source" });
    expect(() =>
      assertOwnerVaultStorageRecord(registered("audit.restore-source"), {
        category: "audit.restore-source",
        version: 1,
        payload: {
          source: { ownerID: "source", vaultID: "vault", generationEpoch: 1 },
          audit: { ownerID: "no" },
        },
      }),
    ).toThrow(OwnerVaultStorageRegistryError);
  });
});
