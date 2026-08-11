// AssistantIdentifiers.swift
// EnchiridionCore
//
// Small identity types for the assistant's tool-calling loop. Ported
// concept from `apps/enchiridion/Sources/EnchiridionCore/AssistantToolAuthorization.swift`
// — only the identity wrappers, not that file's provider-specific executor
// glue (`AssistantLocalToolExecutor`, `OpenAILocalToolResult`, etc.), which
// belongs to the provider-integration follow-on task, or its write-side
// proposal ledger (`AssistantTaskMutationProposal`/
// `AssistantTaskMutationProposalLedger`), which belongs to the write-tools
// follow-on task (plan's "Assistant (P5)" section: "Local graph writes ...
// get an `AssistantTaskMutationProposalLedger`-equivalent").
//
// Confirmed before adding these: this package (grep across
// `Sources/`/`Tests/` for `TurnID`/`InputTurn`) has no existing
// turn-identity or tool-call-identity type yet, so these are new, not
// duplicates of something the realtime-audio work already introduced —
// that work landed only in the OLD app (`apps/enchiridion`, see its
// `AssistantConversationRuntime.swift`/`OnDeviceSpeechTranscriber.swift`),
// not in this package.

import Foundation

/// A provider-neutral identity for one finalized user input (e.g. one
/// turn of a realtime voice conversation, or one submitted text message).
/// It is intentionally local: remote item/response identifiers a provider
/// hands back are correlations, never authority — nothing here should ever
/// be derived from or overwritten by a provider-supplied ID.
public struct RealtimeInputTurnID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// A provider-neutral identity for one tool call within a turn. Used to
/// key both read-tool authorization bookkeeping and (by the write-tools
/// follow-on task) one-shot mutation proposals, so a provider's own
/// call-ID format never leaks into local trust decisions.
public struct AssistantToolCallID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}
