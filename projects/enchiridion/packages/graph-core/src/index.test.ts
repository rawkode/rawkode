import { describe, expect, test } from "bun:test";
import goldenIds from "./__fixtures__/golden-ids.json";
import {
  type CalendarEventMaterializationInput,
  type DailyPageDate,
  deriveBlobId,
  deriveCalendarMaterializedIdentity,
  deriveDailyPageId,
  deriveEmailThreadPageId,
  deriveEventPageId,
  deriveFreePageId,
  derivePersonPageId,
  predicateId,
} from "./index";

// This file is the TS half of the plan's release-blocking cross-language
// golden test ("Critical invariant": deterministic PageIDs ported
// byte-for-byte to TS, locked with cross-language golden tests). It loads
// the single shared fixture file `__fixtures__/golden-ids.json` — the Swift
// side must eventually assert the exact same cases (see
// projects/enchiridion/apps/swift/Tests/GOLDEN_IDS_TODO.md for why that
// isn't wired up yet).

interface DailyFixtureCase {
  description: string;
  input: string | DailyPageDate;
  expectedId: string;
}

interface PersonFixtureCase {
  description: string;
  input: string;
  expectedId: string;
}

interface EventFixtureCase {
  description: string;
  input:
    | {
        iCalendarUID: string;
        provider: string;
        isAllDay: true;
        originalStartCivilDay: string;
        timeZoneIdentifier: string;
      }
    | {
        iCalendarUID: string;
        provider: string;
        isAllDay: false;
        originalStartDateEpochMs: number;
      };
  expectedUidDigest: string;
  expectedSourceScopeDigest: string;
  expectedOccurrenceToken: string;
  expectedId: string;
}

interface EmailThreadFixtureCase {
  description: string;
  input: string;
  expectedId: string;
}

interface BlobFixtureCase {
  description: string;
  inputHex: string;
  expectedId: string;
}

function toMaterializationInput(
  input: EventFixtureCase["input"],
): CalendarEventMaterializationInput {
  if (input.isAllDay) {
    return {
      iCalendarUID: input.iCalendarUID,
      provider: input.provider,
      isAllDay: true,
      originalStartCivilDay: input.originalStartCivilDay,
      timeZoneIdentifier: input.timeZoneIdentifier,
    };
  }
  return {
    iCalendarUID: input.iCalendarUID,
    provider: input.provider,
    isAllDay: false,
    originalStartDate: input.originalStartDateEpochMs,
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe("deriveDailyPageId (golden fixtures)", () => {
  for (const testCase of goldenIds.dailyPageIds as DailyFixtureCase[]) {
    test(testCase.description, () => {
      expect(deriveDailyPageId(testCase.input)).toBe(testCase.expectedId);
    });
  }
});

describe("derivePersonPageId (golden fixtures)", () => {
  for (const testCase of goldenIds.personPageIds as PersonFixtureCase[]) {
    test(testCase.description, async () => {
      expect(await derivePersonPageId(testCase.input)).toBe(testCase.expectedId);
    });
  }
});

describe("deriveEventPageId / deriveCalendarMaterializedIdentity (golden fixtures)", () => {
  for (const testCase of goldenIds.eventPageIds as EventFixtureCase[]) {
    test(testCase.description, async () => {
      const identity = await deriveCalendarMaterializedIdentity(
        toMaterializationInput(testCase.input),
      );
      expect(identity).toBeDefined();
      if (!identity) return;

      expect(identity.version).toBe(1);
      expect(identity.uidDigest).toBe(testCase.expectedUidDigest);
      expect(identity.sourceScopeDigest).toBe(testCase.expectedSourceScopeDigest);
      expect(identity.occurrenceToken).toBe(testCase.expectedOccurrenceToken);

      expect(await deriveEventPageId(identity)).toBe(testCase.expectedId);
    });
  }
});

describe("deriveBlobId (golden fixtures)", () => {
  for (const testCase of goldenIds.blobIds as BlobFixtureCase[]) {
    test(testCase.description, async () => {
      const bytes = hexToBytes(testCase.inputHex);
      expect(await deriveBlobId(bytes)).toBe(testCase.expectedId);
      // ArrayBuffer input must produce the identical id.
      expect(await deriveBlobId(bytes.buffer as ArrayBuffer)).toBe(testCase.expectedId);
    });
  }
});

describe("deriveEmailThreadPageId (golden fixtures)", () => {
  for (const testCase of goldenIds.emailThreadPageIds as EmailThreadFixtureCase[]) {
    test(testCase.description, async () => {
      expect(await deriveEmailThreadPageId(testCase.input)).toBe(testCase.expectedId);
    });
  }

  test("same threadId digests to the same PageID on every call (deterministic)", async () => {
    const first = await deriveEmailThreadPageId("thread-determinism-check");
    const second = await deriveEmailThreadPageId("thread-determinism-check");
    expect(first).toBe(second);
  });

  test("distinct threadIds produce distinct PageIDs", async () => {
    const a = await deriveEmailThreadPageId("thread-a");
    const b = await deriveEmailThreadPageId("thread-b");
    expect(a).not.toBe(b);
  });

  test("the raw threadId never appears in the derived PageID (digest-only, no provider-id leakage)", async () => {
    const threadId = "17c3f9a1b2d4e5f6-should-not-leak";
    const pageId = await deriveEmailThreadPageId(threadId);
    expect(pageId.startsWith("email_thread_")).toBe(true);
    expect(pageId).not.toContain(threadId);
  });
});

describe("predicateId", () => {
  test("formats tag/field pair as property:<tagID>:<fieldID>", () => {
    expect(predicateId("dev.rawkode.event", "start")).toBe(
      "property:dev.rawkode.event:start",
    );
  });
});

describe("deriveFreePageId", () => {
  test("produces a page_-prefixed, distinct id on each call", () => {
    const first = deriveFreePageId();
    const second = deriveFreePageId();
    expect(first).toMatch(/^page_[0-9a-f-]{36}$/);
    expect(second).toMatch(/^page_[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});
