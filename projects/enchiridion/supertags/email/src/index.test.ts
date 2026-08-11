import { describe, expect, test } from "bun:test";
import { SupertagRegistry } from "@enchiridion/schema";
import coreModule, { CoreSupertagIDs } from "@enchiridion/supertags-core";
import emailModule, { EmailSupertagIDs } from "./index";

describe("dev.rawkode.enchiridion.email — registry validation", () => {
  test("SupertagRegistry.build([coreModule, emailModule]) succeeds with no validation errors", () => {
    expect(() => SupertagRegistry.build([coreModule, emailModule])).not.toThrow();
  });

  test("emailModule alone (without core loaded) also passes single-module validation", () => {
    // entityReference `allowedSupertagIDs`/relation endpoints referencing a
    // foreign module's supertag id is legal even before that module is
    // loaded — cross-module dangling references are only a problem for
    // inheritance cycle detection, not namespace ownership (see
    // registry.ts's `qualifyModule` header). `defineSupertagModule` itself
    // (called at this module's own definition time, in index.ts) already
    // proves this passes without `core` present.
    expect(() => SupertagRegistry.build([emailModule])).not.toThrow();
  });

  test("declares exactly the emailThread supertag", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    const emailIds = registry
      .allSupertags()
      .map((s) => s.id)
      .filter((id) => id.startsWith(emailModule.id));
    expect(emailIds).toEqual([EmailSupertagIDs.emailThread]);
  });

  test("declares exactly the 3 email relations (from/to/cc)", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    const emailRelations = registry.allRelations().filter((r) => r.id.startsWith(emailModule.id));
    expect(emailRelations).toHaveLength(3);
  });
});

describe("EmailThread field shape", () => {
  test("declares subject, labels, snippet, lastMessageAt, messageCount, and from/to/cc entityReference fields", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    const emailThread = registry.getSupertag(EmailSupertagIDs.emailThread);
    expect(emailThread).toBeDefined();

    const fields = emailThread!.fields;
    expect(fields.subject?.type).toBe("text");
    expect(fields.subject?.allowsMultiple).toBeFalsy();

    expect(fields.labels?.type).toBe("text");
    expect(fields.labels?.allowsMultiple).toBe(true);

    expect(fields.snippet?.type).toBe("text");
    expect(fields.snippet?.isMultiline).toBe(true);

    expect(fields.lastMessageAt?.type).toBe("dateTime");
    expect(fields.messageCount?.type).toBe("number");

    for (const key of ["from", "to", "cc"] as const) {
      expect(fields[key]?.type).toBe("entityReference");
      expect(fields[key]?.allowsMultiple).toBe(true);
      expect(fields[key]?.allowedSupertagIDs).toEqual([CoreSupertagIDs.person]);
    }
  });

  test("no message-body-shaped field exists on this module (bodies stay out of the CRDT graph)", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    const emailThread = registry.getSupertag(EmailSupertagIDs.emailThread);
    const fieldKeys = Object.keys(emailThread!.fields);
    for (const key of fieldKeys) {
      expect(key.toLowerCase()).not.toContain("body");
    }
  });
});

describe("participant relations resolve to real declared relations, not the synthetic fallback", () => {
  const referenceFields: Array<{ label: string; fieldID: "from" | "to" | "cc" }> = [
    { label: "emailThread.from", fieldID: "from" },
    { label: "emailThread.to", fieldID: "to" },
    { label: "emailThread.cc", fieldID: "cc" },
  ];

  for (const { label, fieldID } of referenceFields) {
    test(`${label} resolves to a real declared relation`, () => {
      const registry = SupertagRegistry.build([coreModule, emailModule]);
      const relationID = registry.relationIDForProperty({
        supertagID: EmailSupertagIDs.emailThread,
        fieldID,
      });
      expect(relationID.startsWith("property-relation:")).toBe(false);
      expect(relationID.startsWith(`${emailModule.id}.`)).toBe(true);
      // Round-trips back to the same property key.
      expect(registry.propertyKeyForRelation(relationID)).toEqual({
        supertagID: EmailSupertagIDs.emailThread,
        fieldID,
      });
    });
  }

  test("every entityReference field on emailThread is accounted for above (none silently left on the fallback)", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    const emailThread = registry.getSupertag(EmailSupertagIDs.emailThread)!;
    const entityReferenceFieldKeys = Object.entries(emailThread.fields)
      .filter(([, def]) => def.type === "entityReference")
      .map(([fieldID]) => fieldID);

    expect(entityReferenceFieldKeys.sort()).toEqual(referenceFields.map((f) => f.fieldID).sort());
  });

  test("each from/to/cc relation targets core's person supertag", () => {
    const registry = SupertagRegistry.build([coreModule, emailModule]);
    for (const { fieldID } of referenceFields) {
      const relationID = registry.relationIDForProperty({
        supertagID: EmailSupertagIDs.emailThread,
        fieldID,
      });
      const relation = registry.allRelations().find((r) => r.id === relationID);
      expect(relation?.from).toEqual([EmailSupertagIDs.emailThread]);
      expect(relation?.to).toEqual([CoreSupertagIDs.person]);
      expect(relation?.cardinality).toBe("manyToMany");
    }
  });
});
