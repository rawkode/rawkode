import { describe, expect, test } from "bun:test";
import { initializeSchema } from "./schema";
import { hasExchangedMailWith, qualifyingParticipants, recordSentTo } from "./gmail-participants-store";
import { SqliteStorageAdapter } from "./test-helpers/sqlite-storage-adapter";

function makeSql(): SqliteStorageAdapter {
  const sql = new SqliteStorageAdapter();
  initializeSchema(sql);
  return sql;
}

describe("gmail-participants-store — the participant quality gate ledger", () => {
  test("an address never recorded does not qualify", () => {
    const sql = makeSql();
    expect(hasExchangedMailWith(sql, "newsletter@example.com")).toBe(false);
  });

  test("recording a sent-to fact makes the address qualify", () => {
    const sql = makeSql();
    recordSentTo(sql, "friend@example.com", 1000);
    expect(hasExchangedMailWith(sql, "friend@example.com")).toBe(true);
  });

  test("email comparison is normalized (trim + lowercase) on both write and read", () => {
    const sql = makeSql();
    recordSentTo(sql, "  Friend@Example.com  ", 1000);
    expect(hasExchangedMailWith(sql, "friend@example.com")).toBe(true);
    expect(hasExchangedMailWith(sql, "FRIEND@EXAMPLE.COM")).toBe(true);
  });

  test("recording the same address twice accumulates the count but stays qualified (a >0 check, not exactly-1)", () => {
    const sql = makeSql();
    recordSentTo(sql, "friend@example.com", 1000);
    recordSentTo(sql, "friend@example.com", 2000);
    expect(hasExchangedMailWith(sql, "friend@example.com")).toBe(true);
  });

  test("qualification is a ONE-WAY RATCHET across ingest cycles — once true, a later cycle with no new sent-to fact for the address doesn't un-qualify it", () => {
    const sql = makeSql();
    recordSentTo(sql, "friend@example.com", 1000);
    expect(hasExchangedMailWith(sql, "friend@example.com")).toBe(true);
    // No further recordSentTo calls for this address — simulating many
    // later cycles where the user never emails them again.
    expect(hasExchangedMailWith(sql, "friend@example.com")).toBe(true);
  });

  describe("qualifyingParticipants — bulk gate check", () => {
    test("returns exactly the subset of candidate addresses that qualify", () => {
      const sql = makeSql();
      recordSentTo(sql, "friend@example.com", 1000);
      recordSentTo(sql, "colleague@example.com", 1000);

      const result = qualifyingParticipants(sql, ["friend@example.com", "newsletter@example.com", "colleague@example.com"]);
      expect(result).toEqual(new Set(["friend@example.com", "colleague@example.com"]));
    });

    test("an empty candidate list returns an empty set without touching SQLite", () => {
      const sql = makeSql();
      expect(qualifyingParticipants(sql, [])).toEqual(new Set());
    });

    test("normalizes candidate emails before comparing", () => {
      const sql = makeSql();
      recordSentTo(sql, "friend@example.com", 1000);
      const result = qualifyingParticipants(sql, ["  Friend@Example.com  "]);
      expect(result).toEqual(new Set(["friend@example.com"]));
    });
  });
});
