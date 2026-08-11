// @enchiridion/worker-gatekeeper-google — converts this worker's own
// storage rows (`gmail-body-store.ts`'s `StoredMessageBody`,
// `gmail-attachment-store.ts`'s `StoredAttachment`) into
// `@enchiridion/gatekeeper-google-rpc-contract`'s `EmailMessageDTO` — the
// one shape `google-account-do.ts`'s `getMessagesForThreads`/
// `searchEmailMessages` RPC methods hand back to `gmail-read-model.ts`'s
// scope-gated wrapper functions, which return it as-is to `GmailReadModel`
// (`index.ts`) — the real Workers-RPC method `workers/vault`'s resolvers
// call. A pure, dependency-free mapping function kept separate from both
// the storage layer (which shouldn't know about the cross-worker DTO
// shape) and the DO/read-model layers (which shouldn't duplicate this
// field-by-field mapping at each of their two call sites).

import type { EmailAttachmentDTO, EmailMessageDTO } from "@enchiridion/gatekeeper-google-rpc-contract";
import type { StoredAttachment } from "./gmail-attachment-store";
import type { StoredMessageBody } from "./gmail-body-store";

function toAttachmentDTO(attachment: StoredAttachment): EmailAttachmentDTO {
  return {
    blobID: attachment.blobID,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

/** `body.headers` is keyed by the exact header names `gmail-mime.ts`
 *  extracts (`From`/`To`/`Cc`/`Subject`/`Date`) — see that module's
 *  `HEADERS_TO_EXTRACT` constant. */
export function toEmailMessageDTO(body: StoredMessageBody, attachments: readonly StoredAttachment[]): EmailMessageDTO {
  return {
    id: body.messageID,
    threadPageID: body.pageID,
    from: body.headers.From,
    to: body.headers.To,
    cc: body.headers.Cc,
    subject: body.headers.Subject,
    date: body.headers.Date,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    receivedAt: body.receivedAt,
    attachments: attachments.map(toAttachmentDTO),
  };
}
