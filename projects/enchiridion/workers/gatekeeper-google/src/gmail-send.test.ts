import { describe, expect, test } from "bun:test";
import { GmailApiError } from "./gmail-api";
import { decodeBase64Url } from "./gmail-mime";
import {
  buildRawEmailMessage,
  generateGmailMessageId,
  sendGmailMessage,
  SendEmailValidationError,
  validateSendEmailInput,
} from "./gmail-send";

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string, init?: RequestInit) => handler(new URL(input), init)) as unknown as typeof fetch;
}

describe("buildRawEmailMessage", () => {
  test("builds To/Subject/MIME headers + a blank-line-separated body, CRLF endings", () => {
    const raw = buildRawEmailMessage({ to: ["guest@example.com"], subject: "Hello", body: "Just checking in." });
    const [headerBlock, body] = raw.split("\r\n\r\n");
    const headerLines = headerBlock!.split("\r\n");

    expect(headerLines).toContain("To: guest@example.com");
    expect(headerLines).toContain("Subject: Hello");
    expect(headerLines).toContain("MIME-Version: 1.0");
    expect(headerLines).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(headerLines).toContain("Content-Transfer-Encoding: 8bit");
    expect(body).toBe("Just checking in.");
  });

  test("joins multiple To recipients with a comma, and includes Cc/Bcc only when given", () => {
    const withoutCcBcc = buildRawEmailMessage({ to: ["a@example.com", "b@example.com"], subject: "s", body: "b" });
    expect(withoutCcBcc).toContain("To: a@example.com, b@example.com");
    expect(withoutCcBcc).not.toContain("Cc:");
    expect(withoutCcBcc).not.toContain("Bcc:");

    const withCcBcc = buildRawEmailMessage({
      to: ["a@example.com"],
      cc: ["c@example.com"],
      bcc: ["hidden@example.com"],
      subject: "s",
      body: "b",
    });
    expect(withCcBcc).toContain("Cc: c@example.com");
    expect(withCcBcc).toContain("Bcc: hidden@example.com");
  });

  test("a 7-bit-ASCII subject is left unencoded", () => {
    const raw = buildRawEmailMessage({ to: ["a@example.com"], subject: "Plain ASCII subject", body: "b" });
    expect(raw).toContain("Subject: Plain ASCII subject");
  });

  test("a non-ASCII subject is RFC 2047 encoded-word wrapped, not sent as raw UTF-8 header bytes", () => {
    const raw = buildRawEmailMessage({ to: ["a@example.com"], subject: "Café ☕ update", body: "b" });
    const subjectLine = raw.split("\r\n").find((line) => line.startsWith("Subject:"));
    expect(subjectLine).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/);
    // Decode it back to prove the encoded-word actually carries the real text.
    const encodedWord = /^Subject: =\?UTF-8\?B\?(.+)\?=$/.exec(subjectLine!)![1]!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(encodedWord), (c) => c.charCodeAt(0)))).toBe("Café ☕ update");
  });

  test("body content is UTF-8 text carried through verbatim (not base64/quoted-printable inner-encoded)", () => {
    const raw = buildRawEmailMessage({ to: ["a@example.com"], subject: "s", body: "Café ☕ — multi-byte body text" });
    expect(raw.endsWith("Café ☕ — multi-byte body text")).toBe(true);
  });

  test("a messageId, when given, is emitted as a Message-ID header", () => {
    const raw = buildRawEmailMessage({
      to: ["a@example.com"],
      subject: "s",
      body: "b",
      messageId: "<abc-123@gatekeeper.enchiridion.rawkode.academy>",
    });
    expect(raw).toContain("Message-ID: <abc-123@gatekeeper.enchiridion.rawkode.academy>");
  });

  test("no messageId given: no Message-ID header at all", () => {
    const raw = buildRawEmailMessage({ to: ["a@example.com"], subject: "s", body: "b" });
    expect(raw).not.toContain("Message-ID:");
  });
});

// ---------------------------------------------------------------------------
// Fix 1 (adversarial review, plan §Google gatekeeper) — RFC 2822 header
// injection. `buildRawEmailMessage` used to concatenate caller-supplied
// to/cc/bcc/subject directly into header lines with zero sanitization; a
// value containing "\r\nBcc: attacker@evil.com" would inject a real header,
// and "\r\n\r\n" would override the entire MIME body. These tests prove
// each of to/cc/bcc/subject is independently rejected, not silently
// stripped.
// ---------------------------------------------------------------------------

describe("validateSendEmailInput / buildRawEmailMessage — Fix 1: RFC 2822 header-injection hardening", () => {
  test("a CRLF-injection attempt in `to` is rejected with a clear error, not silently stripped", () => {
    const input = { to: ["guest@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" };
    expect(() => validateSendEmailInput(input)).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput(input)).toThrow(/to/i);
    expect(() => buildRawEmailMessage(input)).toThrow(SendEmailValidationError);
  });

  test("a CRLF-injection attempt in `cc` is rejected independently of `to`/`bcc`/`subject`", () => {
    const input = { to: ["guest@example.com"], cc: ["cc@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" };
    expect(() => validateSendEmailInput(input)).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput(input)).toThrow(/cc/i);
  });

  test("a CRLF-injection attempt in `bcc` is rejected independently of `to`/`cc`/`subject`", () => {
    const input = { to: ["guest@example.com"], bcc: ["hidden@example.com\r\nBcc: attacker@evil.com"], subject: "Hello", body: "b" };
    expect(() => validateSendEmailInput(input)).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput(input)).toThrow(/bcc/i);
  });

  test("a CRLF-injection attempt in `subject` (the classic '\\r\\n\\r\\n body override' attack) is rejected independently", () => {
    const input = { to: ["guest@example.com"], subject: "Hello\r\n\r\nEntirely different body content", body: "b" };
    expect(() => validateSendEmailInput(input)).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput(input)).toThrow(/subject/i);
    expect(() => buildRawEmailMessage(input)).toThrow(SendEmailValidationError);
  });

  test("a bare LF (no CR) injection attempt is rejected too, in every field", () => {
    expect(() => validateSendEmailInput({ to: ["a@example.com\nBcc: x@evil.com"], subject: "s", body: "b" })).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput({ to: ["a@example.com"], subject: "s\nBcc: x@evil.com", body: "b" })).toThrow(SendEmailValidationError);
  });

  test("an implausible (non-email-shaped) address is rejected — not just a CRLF check", () => {
    expect(() => validateSendEmailInput({ to: ["not-an-email"], subject: "s", body: "b" })).toThrow(SendEmailValidationError);
    expect(() => validateSendEmailInput({ to: ["a@example.com"], cc: ["also not an email"], subject: "s", body: "b" })).toThrow(SendEmailValidationError);
  });

  test("an empty `to` list is rejected", () => {
    expect(() => validateSendEmailInput({ to: [], subject: "s", body: "b" })).toThrow(SendEmailValidationError);
  });

  test("ordinary valid input passes validation without throwing", () => {
    expect(() =>
      validateSendEmailInput({
        to: ["a@example.com"],
        cc: ["c@example.com"],
        bcc: ["b@example.com"],
        subject: "A perfectly normal subject line",
        body: "Body content — CRLF here would be fine, it's past the headers.",
      }),
    ).not.toThrow();
  });
});

describe("generateGmailMessageId — Fix 2: idempotency key generation", () => {
  test("produces an angle-bracket-wrapped, unique value each call", () => {
    const a = generateGmailMessageId();
    const b = generateGmailMessageId();
    expect(a).toMatch(/^<.+@.+>$/);
    expect(b).toMatch(/^<.+@.+>$/);
    expect(a).not.toBe(b);
  });
});

describe("sendGmailMessage — the real Gmail messages.send API MUTATION call", () => {
  test("POSTs to messages/send with a base64url `raw` field decoding to the correctly-encoded MIME message", async () => {
    let seenUrl: URL | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ id: "sent-1", threadId: "thread-1", labelIds: ["SENT"] }), { status: 200 });
    });

    const result = await sendGmailMessage(
      "access-token-1",
      { to: ["guest@example.com"], cc: ["cc@example.com"], subject: "Hello", body: "Just checking in." },
      fetchImpl,
    );

    expect(result.id).toBe("sent-1");
    expect(result.threadId).toBe("thread-1");
    expect(seenUrl?.pathname).toBe("/gmail/v1/users/me/messages/send");
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>)?.authorization).toBe("Bearer access-token-1");

    const sentBody = JSON.parse(seenInit!.body as string) as { raw: string };
    expect(sentBody.raw).not.toContain("+");
    expect(sentBody.raw).not.toContain("/");
    expect(sentBody.raw).not.toContain("=");

    const decodedRaw = new TextDecoder().decode(decodeBase64Url(sentBody.raw));
    expect(decodedRaw).toContain("To: guest@example.com");
    expect(decodedRaw).toContain("Cc: cc@example.com");
    expect(decodedRaw).toContain("Subject: Hello");
    expect(decodedRaw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(decodedRaw.endsWith("Just checking in.")).toBe(true);
  });

  test("a non-2xx response throws GmailApiError, not a crash", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 }),
    );
    const rejection = sendGmailMessage("tok", { to: ["a@example.com"], subject: "s", body: "b" }, fetchImpl);
    await expect(rejection).rejects.toBeInstanceOf(GmailApiError);
    await expect(rejection).rejects.toThrow(/messages\.send failed/);
    try {
      await rejection;
    } catch (error) {
      expect((error as GmailApiError).status).toBe(403);
    }
  });
});
