import { describe, expect, test } from "bun:test";
import {
  decodeVersionVector,
  emptyVersionVector,
  encodeVersionVector,
  LoroPageDoc,
} from "./loro-storage";

describe("LoroPageDoc — real loro-crdt round trips (not mocked)", () => {
  test("create, edit, export snapshot, and reopen from that snapshot", () => {
    const page = LoroPageDoc.create();
    page.text("body").insert(0, "Hello");
    page.commit();

    const snapshot = page.exportSnapshot();
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.length).toBeGreaterThan(0);

    const reopened = LoroPageDoc.fromSnapshot(snapshot);
    expect(reopened.textContent("body")).toBe("Hello");
  });

  test("exportUpdatesSince + importBytes round trip between two docs", () => {
    const source = LoroPageDoc.create();
    source.text("body").insert(0, "Hi");
    source.commit();

    const target = LoroPageDoc.create();
    const before = target.versionVector();
    const update = source.exportUpdatesSince(decodeVersionVector(encodeVersionVector(before)));

    const outcome = target.importBytes(update);
    expect(outcome.changedState).toBe(true);
    expect(outcome.hasPendingDependencies).toBe(false);
    expect(target.textContent("body")).toBe("Hi");
  });

  test("importing bytes the doc already has is a no-op merge", () => {
    const source = LoroPageDoc.create();
    source.text("body").insert(0, "Hi");
    source.commit();
    const snapshot = source.exportSnapshot();

    const target = LoroPageDoc.fromSnapshot(snapshot);
    // Re-importing the exact same snapshot bytes should change nothing.
    const outcome = target.importBytes(snapshot);
    expect(outcome.changedState).toBe(false);
  });

  test("doc-store's open(): snapshot + pending updates replay to the same state as one big snapshot", () => {
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "A");
    writer.commit();
    const snapshot = writer.exportSnapshot();
    const vvAfterSnapshot = writer.versionVector();

    writer.text("body").insert(1, "B");
    writer.commit();
    const update1 = writer.exportUpdatesSince(vvAfterSnapshot);
    const vvAfterUpdate1 = writer.versionVector();

    writer.text("body").insert(2, "C");
    writer.commit();
    const update2 = writer.exportUpdatesSince(vvAfterUpdate1);

    const reader = LoroPageDoc.open(snapshot, [update1, update2]);
    expect(reader.textContent("body")).toBe("ABC");
  });

  test("shallow snapshot round trip preserves current state (compaction interop)", () => {
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "full history please");
    writer.commit();

    const shallow = writer.exportShallowSnapshot();
    const reader = LoroPageDoc.fromSnapshot(shallow);
    expect(reader.textContent("body")).toBe("full history please");
  });

  test("map container: set/delete and shallow-value read", () => {
    const page = LoroPageDoc.create();
    page.map("objectMetadata").set("status", "todo");
    page.map("objectMetadata").set("priority", 2);
    page.commit();

    expect(page.mapShallowValue("objectMetadata")).toEqual({ status: "todo", priority: 2 });

    page.map("objectMetadata").delete("priority");
    page.commit();
    expect(page.mapShallowValue("objectMetadata")).toEqual({ status: "todo" });
  });

  test("rich text marks configured at doc creation work without a StyleConfigMissing-equivalent error", () => {
    const page = LoroPageDoc.create();
    const text = page.text("body");
    text.insert(0, "Hello World");
    text.mark({ start: 0, end: 5 }, "bold", true);
    page.commit();

    expect(page.textContent("body")).toBe("Hello World");
  });

  test("version vectors encode/decode round trip and compare as expected", () => {
    const page = LoroPageDoc.create();
    page.text("body").insert(0, "x");
    page.commit();

    const vv = page.versionVector();
    const roundTripped = decodeVersionVector(encodeVersionVector(vv));
    expect(encodeVersionVector(roundTripped)).toEqual(encodeVersionVector(vv));
  });

  test("emptyVersionVector round trips through encode/decode", () => {
    const empty = emptyVersionVector();
    const decoded = decodeVersionVector(encodeVersionVector(empty));
    expect(encodeVersionVector(decoded)).toEqual(encodeVersionVector(empty));
  });

  test("decodeVersionVector accepts a zero-length byte array as 'start of time'", () => {
    const vv = decodeVersionVector(new Uint8Array(0));
    expect(encodeVersionVector(vv)).toEqual(encodeVersionVector(emptyVersionVector()));
  });
});

describe("LoroPageDoc — needsFullSnapshotFor (compaction-horizon / device-in-a-drawer detection)", () => {
  test("a non-shallow doc never needs a full snapshot, even for an empty client VV", () => {
    const page = LoroPageDoc.create();
    page.text("body").insert(0, "hello");
    page.commit();

    expect(page.needsFullSnapshotFor(emptyVersionVector())).toBe(false);
  });

  test("a client whose VV predates the shallow horizon needs a full snapshot", () => {
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "A");
    writer.commit();
    // A stale client's VV, captured before any further edits.
    const staleClientVV = writer.versionVector();

    writer.text("body").insert(1, "B");
    writer.commit();
    writer.text("body").insert(2, "C");
    writer.commit();

    // Compact — this is what makes the doc "shallow" going forward and
    // establishes a compaction horizon past the stale client's VV.
    const shallowSnapshot = writer.exportShallowSnapshot();
    const compacted = LoroPageDoc.fromSnapshot(shallowSnapshot);

    expect(compacted.needsFullSnapshotFor(staleClientVV)).toBe(true);
  });

  test("a client at or beyond the shallow horizon does NOT need a full snapshot", () => {
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "A");
    writer.commit();
    writer.text("body").insert(1, "B");
    writer.commit();

    const shallowSnapshot = writer.exportShallowSnapshot();
    const compacted = LoroPageDoc.fromSnapshot(shallowSnapshot);
    // The writer's own current VV is at/beyond the horizon by construction.
    const currentClientVV = writer.versionVector();

    expect(compacted.needsFullSnapshotFor(currentClientVV)).toBe(false);
  });

  test("a genuinely unrelated (disjoint) client VV is treated as needing a full snapshot", () => {
    const writer = LoroPageDoc.create();
    writer.text("body").insert(0, "A");
    writer.commit();
    writer.text("body").insert(1, "B");
    writer.commit();
    const shallowSnapshot = writer.exportShallowSnapshot();
    const compacted = LoroPageDoc.fromSnapshot(shallowSnapshot);

    const unrelatedPeerDoc = LoroPageDoc.create();
    unrelatedPeerDoc.text("body").insert(0, "z");
    unrelatedPeerDoc.commit();

    expect(compacted.needsFullSnapshotFor(unrelatedPeerDoc.versionVector())).toBe(true);
  });
});
