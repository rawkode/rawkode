import { describe, expect, test } from "bun:test";
import { toEmailMessageDTO } from "./gmail-message-dto";
import type { StoredMessageBody } from "./gmail-body-store";
import type { StoredAttachment } from "./gmail-attachment-store";

describe("toEmailMessageDTO", () => {
  test("maps headers by name into the DTO's from/to/cc/subject/date fields", () => {
    const body: StoredMessageBody = {
      messageID: "m1",
      pageID: "email_thread_aaa",
      threadID: "18abc0001",
      headers: { From: "alex@example.com", To: "david@rawkode.academy", Cc: "team@example.com", Subject: "Kickoff", Date: "Thu, 6 Aug 2026" },
      bodyText: "plain",
      bodyHtml: "<p>html</p>",
      receivedAt: 12345,
    };

    expect(toEmailMessageDTO(body, [])).toEqual({
      id: "m1",
      threadPageID: "email_thread_aaa",
      from: "alex@example.com",
      to: "david@rawkode.academy",
      cc: "team@example.com",
      subject: "Kickoff",
      date: "Thu, 6 Aug 2026",
      bodyText: "plain",
      bodyHtml: "<p>html</p>",
      receivedAt: 12345,
      attachments: [],
    });
  });

  test("a missing header is undefined in the DTO, not an empty string", () => {
    const body: StoredMessageBody = {
      messageID: "m1",
      pageID: "email_thread_aaa",
      threadID: "18abc0001",
      headers: { Subject: "No sender recorded" },
      receivedAt: 0,
    };
    const dto = toEmailMessageDTO(body, []);
    expect(dto.from).toBeUndefined();
    expect(dto.to).toBeUndefined();
    expect(dto.subject).toBe("No sender recorded");
  });

  test("maps attachments into EmailAttachmentDTO shape", () => {
    const body: StoredMessageBody = {
      messageID: "m1",
      pageID: "email_thread_aaa",
      threadID: "18abc0001",
      headers: {},
      receivedAt: 0,
    };
    const attachments: StoredAttachment[] = [
      { messageID: "m1", blobID: "blob_" + "a".repeat(64), filename: "agenda.pdf", mimeType: "application/pdf", size: 1024 },
    ];
    expect(toEmailMessageDTO(body, attachments).attachments).toEqual([
      { blobID: "blob_" + "a".repeat(64), filename: "agenda.pdf", mimeType: "application/pdf", size: 1024 },
    ]);
  });
});
