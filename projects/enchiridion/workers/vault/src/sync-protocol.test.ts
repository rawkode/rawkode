import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  decodeSyncMessage,
  encodeSyncMessage,
  SyncProtocolDecodeError,
  type SyncProtocolMessage,
} from "./sync-protocol";

describe("sync-protocol — round trips for every message type", () => {
  const cases: SyncProtocolMessage[] = [
    { type: "catalogRequest" },
    {
      type: "catalogDiff",
      entries: [
        { pageID: "daily:2026-08-06", docType: "daily", createdAt: 1000, tombstoned: false, updatedAt: 1000 },
        { pageID: "p1", docType: "free", createdAt: 1, tombstoned: true, updatedAt: 999 },
      ],
    },
    { type: "docVersionVector", pageID: "p1", versionVector: bytesToBase64(new Uint8Array([1, 2, 3])) },
    { type: "docUpdate", pageID: "p1", bytes: bytesToBase64(new Uint8Array([4, 5, 6])) },
    { type: "docFullSnapshot", pageID: "p1", bytes: bytesToBase64(new Uint8Array([7, 8, 9])) },
    { type: "tombstone", pageID: "p1", undelete: false },
    { type: "tombstone", pageID: "p1", undelete: true },
  ];

  for (const message of cases) {
    test(`round trips ${message.type}`, () => {
      const encoded = encodeSyncMessage(message);
      const decoded = decodeSyncMessage(encoded);
      expect(decoded).toEqual(message);
    });
  }

  test("decodeSyncMessage accepts an ArrayBuffer frame identically to a string frame", () => {
    const message: SyncProtocolMessage = { type: "tombstone", pageID: "p1", undelete: false };
    const text = encodeSyncMessage(message);
    const buffer = new TextEncoder().encode(text).buffer as ArrayBuffer;
    expect(decodeSyncMessage(buffer)).toEqual(message);
  });
});

describe("sync-protocol — wire shape matches the Swift side's JSON conventions", () => {
  test("catalogRequest has no payload beyond the type discriminator", () => {
    const parsed = JSON.parse(encodeSyncMessage({ type: "catalogRequest" }));
    expect(parsed).toEqual({ type: "catalogRequest" });
  });

  test("pageID encodes as a bare string, not {rawValue: ...}", () => {
    const parsed = JSON.parse(
      encodeSyncMessage({ type: "tombstone", pageID: "page_abc", undelete: false }),
    );
    expect(parsed.pageID).toBe("page_abc");
  });

  test("bytes fields encode as base64 strings", () => {
    const parsed = JSON.parse(
      encodeSyncMessage({ type: "docUpdate", pageID: "p1", bytes: bytesToBase64(new Uint8Array([1, 2, 3])) }),
    );
    expect(typeof parsed.bytes).toBe("string");
    expect(base64ToBytes(parsed.bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("sync-protocol — malformed frames fail closed with a decode error, not a crash", () => {
  test("invalid JSON", () => {
    expect(() => decodeSyncMessage("not json{{{")).toThrow(SyncProtocolDecodeError);
  });

  test("JSON that isn't an object", () => {
    expect(() => decodeSyncMessage("42")).toThrow(SyncProtocolDecodeError);
    expect(() => decodeSyncMessage("[1,2,3]")).toThrow(SyncProtocolDecodeError);
    expect(() => decodeSyncMessage('"just a string"')).toThrow(SyncProtocolDecodeError);
  });

  test("missing type field", () => {
    expect(() => decodeSyncMessage("{}")).toThrow(SyncProtocolDecodeError);
  });

  test("unrecognized type", () => {
    expect(() => decodeSyncMessage('{"type":"somethingElse"}')).toThrow(SyncProtocolDecodeError);
  });

  test("docUpdate missing pageID", () => {
    expect(() => decodeSyncMessage('{"type":"docUpdate","bytes":"AAAA"}')).toThrow(
      SyncProtocolDecodeError,
    );
  });

  test("tombstone with wrong-typed undelete", () => {
    expect(() => decodeSyncMessage('{"type":"tombstone","pageID":"p1","undelete":"nope"}')).toThrow(
      SyncProtocolDecodeError,
    );
  });

  test("catalogDiff with a non-array entries field", () => {
    expect(() => decodeSyncMessage('{"type":"catalogDiff","entries":"nope"}')).toThrow(
      SyncProtocolDecodeError,
    );
  });

  test("catalogDiff with a malformed entry inside the array", () => {
    expect(() =>
      decodeSyncMessage('{"type":"catalogDiff","entries":[{"pageID":"p1"}]}'),
    ).toThrow(SyncProtocolDecodeError);
  });
});

describe("base64ToBytes / bytesToBase64", () => {
  test("round trips arbitrary bytes, including 0x00 and 0xff", () => {
    const bytes = new Uint8Array([0, 1, 255, 254, 127, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("round trips an empty byte array", () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  test("invalid base64 throws SyncProtocolDecodeError, not a raw DOMException", () => {
    expect(() => base64ToBytes("not-valid-base64!!!")).toThrow(SyncProtocolDecodeError);
  });
});
