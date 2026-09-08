import { canonicalJson, sha256HexSync, type ChatReviewItem } from "@athenaeum/domain"

/**
 * The review projection is deliberately presentation-only: server code resolves entity labels
 * and this module must never fall back to an opaque id. Keeping that rule here makes it hard for
 * a future UI caller to accidentally put a predicate/node/edge id into visible or accessible UI.
 */
export const visibleReviewLabel = (item: ChatReviewItem): string => {
  const label = item.label.trim()
  return label.length > 0 ? label : "A pending change has unavailable details."
}

export const isNoteForkReviewItem = (item: ChatReviewItem): boolean => item.lane === "legacy-fork"

/**
 * Local, canonical SHA-256 witness for the *complete ordered display projection*. It is never
 * displayed or sent as telemetry. The backend witness remains the authoritative custody fence;
 * this sibling witness makes client invalidation deterministic without relying on JSON.stringify
 * object insertion order.
 */
export const chatReviewPresentationWitness = (input: {
  readonly chatId: string
  readonly witness: string
  readonly noteForkWitness: string
  readonly items: ReadonlyArray<ChatReviewItem>
}): string =>
  sha256HexSync(canonicalJsonToBytes({
    version: "athenaeum.chat-review-presentation.v1",
    chatId: input.chatId,
    witness: input.witness,
    noteForkWitness: input.noteForkWitness,
    items: input.items.map((item) => ({
      kind: item.kind,
      lane: item.lane,
      sequence: item.sequence,
      label: item.label,
      nodeId: item.nodeId,
      forkPreviewLines: item.forkPreviewLines,
      forkPreviewTruncated: item.forkPreviewTruncated
    }))
  }))

const canonicalJsonToBytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJson(value))
