import { describe, expect, test } from "bun:test";
import { normalizeEmail, parseAddressList } from "./gmail-address";

describe("parseAddressList", () => {
  test("a single 'Display Name <addr>' entry", () => {
    expect(parseAddressList("David Flanagan <david@rawkode.academy>")).toEqual([
      { email: "david@rawkode.academy", displayName: "David Flanagan" },
    ]);
  });

  test("a bare address with no display name", () => {
    expect(parseAddressList("someone@example.com")).toEqual([{ email: "someone@example.com" }]);
  });

  test("multiple comma-separated addresses", () => {
    expect(parseAddressList("Alex Guest <alex@example.com>, someone@example.com")).toEqual([
      { email: "alex@example.com", displayName: "Alex Guest" },
      { email: "someone@example.com" },
    ]);
  });

  test("a quoted display name containing a comma is not incorrectly split", () => {
    expect(parseAddressList('"Flanagan, David" <david@rawkode.academy>')).toEqual([
      { email: "david@rawkode.academy", displayName: "Flanagan, David" },
    ]);
  });

  test("undefined/empty header value returns an empty list", () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("   ")).toEqual([]);
  });

  test("a malformed entry with no @ is dropped, not thrown", () => {
    expect(parseAddressList("not-an-address, real@example.com")).toEqual([{ email: "real@example.com" }]);
  });

  test("an empty <> pair is dropped", () => {
    expect(parseAddressList("Nobody <>")).toEqual([]);
  });
});

describe("normalizeEmail", () => {
  test("trims then lowercases, matching derivePersonPageId's normalization order", () => {
    expect(normalizeEmail("  David@RawKode.Academy  ")).toBe("david@rawkode.academy");
  });
});
