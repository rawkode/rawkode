import { describe, expect, test } from "bun:test";
import { decodeBase64Url, decodeBase64UrlText, encodeBase64Url, encodeBase64UrlText, parseGmailMessage } from "./gmail-mime";
import type { GmailMessagePart } from "./gmail-api";

/** Test-only fixture encoder — the INVERSE of `decodeBase64Url`, built
 *  independently (via `Buffer`, not by reusing `decodeBase64Url`'s own
 *  logic) so this test doesn't just check the SUT against itself. Produces
 *  real base64url (RFC 4648 §5, no padding) — exactly Gmail's own wire
 *  format. Named distinctly from the module's own (now real, production)
 *  `encodeBase64Url` export to avoid shadowing it. */
function fixtureEncodeBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("decodeBase64Url / decodeBase64UrlText", () => {
  test("round-trips arbitrary bytes through the url-safe alphabet, including bytes needing padding", () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 10, 20, 30]);
    const encoded = fixtureEncodeBase64Url(original);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect([...decodeBase64Url(encoded)]).toEqual([...original]);
  });

  test("decodeBase64UrlText decodes UTF-8 text, including multi-byte characters", () => {
    const text = "Hello — café ☕";
    expect(decodeBase64UrlText(fixtureEncodeBase64Url(text))).toBe(text);
  });
});

describe("encodeBase64Url / encodeBase64UrlText (gmail-send.ts's encode-direction dependency)", () => {
  test("encodeBase64Url produces the url-safe alphabet with no padding, and round-trips through decodeBase64Url", () => {
    const original = new Uint8Array([0, 1, 2, 62, 63, 253, 254, 255, 10, 20, 30]);
    const encoded = encodeBase64Url(original);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect([...decodeBase64Url(encoded)]).toEqual([...original]);
  });

  test("independently verified against Buffer's base64 (not just checked against the module's own decode)", () => {
    const original = new Uint8Array([255, 254, 0, 128, 127, 1, 2, 3]);
    const expected = Buffer.from(original).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(encodeBase64Url(original)).toBe(expected);
  });

  test("encodeBase64UrlText encodes UTF-8 text (including multi-byte characters) and round-trips through decodeBase64UrlText", () => {
    const text = "Hello — café ☕ 日本語";
    const encoded = encodeBase64UrlText(text);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(decodeBase64UrlText(encoded)).toBe(text);
  });

  test("encodes empty input to an empty string", () => {
    expect(encodeBase64Url(new Uint8Array())).toBe("");
    expect(encodeBase64UrlText("")).toBe("");
  });
});

describe("parseGmailMessage — realistic multipart MIME shapes", () => {
  test("extracts From/To/Cc/Subject/Date headers from the top-level payload", () => {
    const payload: GmailMessagePart = {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Alex Guest <alex@example.com>" },
        { name: "To", value: "david@rawkode.academy" },
        { name: "Cc", value: "team@example.com" },
        { name: "Subject", value: "Project kickoff" },
        { name: "Date", value: "Thu, 6 Aug 2026 09:00:00 +0000" },
        { name: "X-Ignored-Header", value: "not extracted" },
      ],
      body: { data: fixtureEncodeBase64Url("Hey, following up on this...") },
    };

    const parsed = parseGmailMessage(payload);
    expect(parsed.headers).toEqual({
      From: "Alex Guest <alex@example.com>",
      To: "david@rawkode.academy",
      Cc: "team@example.com",
      Subject: "Project kickoff",
      Date: "Thu, 6 Aug 2026 09:00:00 +0000",
    });
    expect(parsed.bodyText).toBe("Hey, following up on this...");
    expect(parsed.bodyHtml).toBeUndefined();
    expect(parsed.attachments).toEqual([]);
  });

  test("a plain single-part text/plain message (no multipart wrapper at all)", () => {
    const payload: GmailMessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Subject", value: "Plain only" }],
      body: { data: fixtureEncodeBase64Url("just plain text") },
    };
    const parsed = parseGmailMessage(payload);
    expect(parsed.bodyText).toBe("just plain text");
    expect(parsed.bodyHtml).toBeUndefined();
  });

  test("multipart/alternative: both text/plain and text/html leaf parts are extracted", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/alternative",
      headers: [{ name: "Subject", value: "Two formats" }],
      parts: [
        { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("plain version") } },
        { mimeType: "text/html", body: { data: fixtureEncodeBase64Url("<p>html version</p>") } },
      ],
    };
    const parsed = parseGmailMessage(payload);
    expect(parsed.bodyText).toBe("plain version");
    expect(parsed.bodyHtml).toBe("<p>html version</p>");
    expect(parsed.attachments).toEqual([]);
  });

  test("multipart/mixed > multipart/alternative + an attachment leaf, nested at depth 2", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      headers: [{ name: "Subject", value: "With attachment" }],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("see attached") } },
            { mimeType: "text/html", body: { data: fixtureEncodeBase64Url("<p>see attached</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "agenda.pdf",
          body: { attachmentId: "attach-1", size: 51200 },
        },
      ],
    };
    const parsed = parseGmailMessage(payload);
    expect(parsed.bodyText).toBe("see attached");
    expect(parsed.bodyHtml).toBe("<p>see attached</p>");
    expect(parsed.attachments).toEqual([
      { filename: "agenda.pdf", mimeType: "application/pdf", data: undefined, attachmentId: "attach-1", size: 51200 },
    ]);
  });

  test("an inlined small attachment (body.data present instead of attachmentId)", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("hi") } },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: fixtureEncodeBase64Url("small attachment content"), size: 25 },
        },
      ],
    };
    const parsed = parseGmailMessage(payload);
    // The attachment leaf has a filename, so it's classified as an
    // attachment even though its mimeType is "text/plain" — NOT folded
    // into bodyText (see this module's header, "isAttachment" precedence).
    expect(parsed.bodyText).toBe("hi");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("notes.txt");
    expect(decodeBase64UrlText(parsed.attachments[0]?.data ?? "")).toBe("small attachment content");
  });

  test("multiple attachments across sibling parts are all collected", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("two files attached") } },
        { mimeType: "image/png", filename: "screenshot.png", body: { attachmentId: "a1", size: 2048 } },
        { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "a2", size: 4096 } },
      ],
    };
    const parsed = parseGmailMessage(payload);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(["screenshot.png", "report.pdf"]);
  });

  test("never throws on a malformed/empty payload — returns an empty-ish ParsedGmailMessage", () => {
    expect(parseGmailMessage(undefined)).toEqual({ headers: {}, bodyText: undefined, bodyHtml: undefined, attachments: [] });
    expect(parseGmailMessage({})).toEqual({ headers: {}, bodyText: undefined, bodyHtml: undefined, attachments: [] });
  });

  test("first-wins: a second text/plain leaf part is ignored, never overwrites or concatenates", () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("first") } },
        { mimeType: "text/plain", body: { data: fixtureEncodeBase64Url("second, ignored") } },
      ],
    };
    expect(parseGmailMessage(payload).bodyText).toBe("first");
  });
});
