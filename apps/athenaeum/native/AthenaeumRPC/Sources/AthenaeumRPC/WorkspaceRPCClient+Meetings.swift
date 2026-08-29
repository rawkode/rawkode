import Foundation
import AthenaeumDomain

// Phase 6 native stage ("Wire transcript segments to the backend's appendTranscriptSegment RPC
// via the established AthenaeumRPC client pattern") — the native client for
// `workspace-durable-object.ts`'s five Phase 6 meetings Cap'n Web methods (`startMeeting`,
// `endMeeting`, `appendTranscriptSegment`, `getMeeting`, `listMeetings` —
// `packages/domain/src/meeting-rpc.ts`). Same `rpc(_:_:)` dispatch / hand-rolled
// "RPC*"-prefixed decode-struct convention as `WorkspaceRPCClient+Calendar.swift`/
// `WorkspaceRPCClient+Sharing.swift`/`WorkspaceRPCClient+Graph.swift` — deliberately its own ad-hoc decode
// types here (not `AthenaeumDomain`'s Codable mirrors), matching every other
// `WorkspaceRPCClient+*.swift` extension file's existing precedent (see `WorkspaceRPCClient+Calendar.swift`'s
// own header comment for why). `voiceSession` RPC methods (`startVoiceSession`/`endVoiceSession`,
// `voice-session-rpc.ts`) are deliberately NOT added here — this stage's own scope is the
// transcription/meetings surface (native audio capture -> on-device ASR -> `appendTranscriptSegment`),
// not realtime voice, which has no native-client consumer yet.
//
// All five methods below are `requireRoleForGovernedWorkspace`-gated server-side
// (`startMeeting`/`endMeeting`/`appendTranscriptSegment` -> `"build"`, `getMeeting`/`listMeetings`
// -> `"use"`) — confirmed by reading `workspace-durable-object.ts`'s own Phase 6 section, not assumed.
// Ledgered `startMeeting` and `appendTranscriptSegment` additionally require an authenticated
// connection even for an ungoverned workspace; `endMeeting` remains governed-role-only until its
// own ledger migration.

/// Mirrors `packages/domain/src/meeting.ts`'s `Meeting`.
public struct RPCMeeting: Sendable, Equatable {
    public let id: String
    public let workspaceId: String
    public let title: String
    public let startedAt: String
    public let endedAt: String?
    public let linkedNodeId: String?

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let workspaceId = try value.field("workspaceId").stringValue,
              let title = try value.field("title").stringValue,
              let startedAt = try value.field("startedAt").stringValue
        else { throw CapnWebError.malformedMessage("malformed Meeting: \(value)") }
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.startedAt = startedAt
        self.endedAt = try value.field("endedAt").stringValue
        self.linkedNodeId = try value.field("linkedNodeId").stringValue
    }
}

/// Mirrors `packages/domain/src/meeting.ts`'s `Speaker`.
public struct RPCSpeaker: Sendable, Equatable {
    public let id: String
    public let meetingId: String
    public let label: String

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let meetingId = try value.field("meetingId").stringValue,
              let label = try value.field("label").stringValue
        else { throw CapnWebError.malformedMessage("malformed Speaker: \(value)") }
        self.id = id
        self.meetingId = meetingId
        self.label = label
    }
}

/// Mirrors `packages/domain/src/meeting.ts`'s `TranscriptSegmentRecord` — see that file's own
/// header comment for why this is `Record`-suffixed (disambiguates from `cloud-transcription.ts`'s
/// unrelated, ephemeral `TranscriptSegment`).
public struct RPCTranscriptSegmentRecord: Sendable, Equatable {
    public let id: String
    public let meetingId: String
    public let speakerId: String?
    public let text: String
    public let startOffsetMs: Int
    public let endOffsetMs: Int
    public let source: String

    /// Public memberwise init — lets a `TranscriptSegmentSink` test double
    /// (`MeetingTranscriptionPipelineTests`, `AthenaeumCore`) construct a return value without
    /// reaching into this module's wire-decode internals, the same way `TranscriptSegmentSink`
    /// itself is a protocol precisely so tests don't need a live `WorkspaceRPCClient`.
    public init(id: String, meetingId: String, speakerId: String?, text: String, startOffsetMs: Int, endOffsetMs: Int, source: String) {
        self.id = id
        self.meetingId = meetingId
        self.speakerId = speakerId
        self.text = text
        self.startOffsetMs = startOffsetMs
        self.endOffsetMs = endOffsetMs
        self.source = source
    }

    init(_ value: CapnWebValue) throws {
        guard let id = try value.field("id").stringValue,
              let meetingId = try value.field("meetingId").stringValue,
              let text = try value.field("text").stringValue,
              let startOffsetMs = try value.field("startOffsetMs").intValue,
              let endOffsetMs = try value.field("endOffsetMs").intValue,
              let source = try value.field("source").stringValue
        else { throw CapnWebError.malformedMessage("malformed TranscriptSegmentRecord: \(value)") }
        self.id = id
        self.meetingId = meetingId
        self.speakerId = try value.field("speakerId").stringValue
        self.text = text
        self.startOffsetMs = startOffsetMs
        self.endOffsetMs = endOffsetMs
        self.source = source
    }
}

extension WorkspaceRPCClient {
    // MARK: - Meetings

    /// `role` gate: `"build"`. Creates a new `Meeting` row, `endedAt` unset (in progress).
    public func startMeeting(
        title: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCMeeting {
        let result = try await rpc("startMeeting", [
            "title": .string(title),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": meetingMutationAttributionValue(attribution)
        ])
        return try RPCMeeting(result.field("meeting"))
    }

    private func meetingMutationAttributionValue(_ attribution: MutationAttribution) -> CapnWebValue {
        var fields: [String: CapnWebValue] = [
            "version": .string(attribution.version),
            "kind": .string(attribution.kind)
        ]
        if let surface = attribution.surface { fields["surface"] = .string(surface) }
        if let jobId = attribution.jobId { fields["jobId"] = .string(jobId) }
        if let runId = attribution.runId { fields["runId"] = .string(runId) }
        if let source = attribution.source { fields["source"] = .string(source) }
        return .object(fields)
    }

    /// `role` gate: `"build"`. Sets `endedAt` on an in-progress meeting. `endedAt` is an ISO-8601
    /// string (`IsoDateTimeString`, `meeting-rpc.ts`'s `EndMeetingInput`) — callers typically pass
    /// `ISO8601DateFormatter().string(from: Date())`.
    public func endMeeting(meetingId: String, endedAt: String) async throws -> RPCMeeting {
        let result = try await rpc("endMeeting", [
            "meetingId": .string(meetingId),
            "endedAt": .string(endedAt)
        ])
        return try RPCMeeting(result.field("meeting"))
    }

    /// `role` gate: `"build"`. Appends one transcribed segment to `meetingId`'s transcript — the
    /// real RPC front end `MeetingTranscriptionPipeline` (`AthenaeumCore`) calls once per
    /// on-device-transcribed (or cloud-fallback-transcribed) `AudioChunk`. `source` is `"on-device"`
    /// or `"cloud"` (`meeting.ts`'s `TranscriptSegmentSource` literal union — passed as a plain
    /// `String` here per this file's own "ad-hoc decode types, not `AthenaeumDomain` mirrors"
    /// convention; the server-side `Schema.Literal` rejects any other value).
    public func appendTranscriptSegment(
        meetingId: String,
        speakerId: String? = nil,
        text: String,
        startOffsetMs: Int,
        endOffsetMs: Int,
        source: String,
        requestId: String,
        commitMessage: String,
        attribution: MutationAttribution
    ) async throws -> RPCTranscriptSegmentRecord {
        var args: [String: CapnWebValue] = [
            "meetingId": .string(meetingId),
            "text": .string(text),
            "startOffsetMs": .int(startOffsetMs),
            "endOffsetMs": .int(endOffsetMs),
            "source": .string(source),
            "requestId": .string(requestId),
            "commitMessage": .string(commitMessage),
            "attribution": .object([
                "version": .string(attribution.version),
                "kind": .string(attribution.kind),
                "surface": attribution.surface.map(CapnWebValue.string) ?? .undefined,
                "jobId": attribution.jobId.map(CapnWebValue.string) ?? .undefined,
                "runId": attribution.runId.map(CapnWebValue.string) ?? .undefined,
                "source": attribution.source.map(CapnWebValue.string) ?? .undefined
            ])
        ]
        args["speakerId"] = speakerId.map(CapnWebValue.string) ?? .undefined
        let result = try await rpc("appendTranscriptSegment", args)
        return try RPCTranscriptSegmentRecord(result.field("segment"))
    }

    /// `role` gate: `"use"`. One aggregate read: the meeting, its full transcript (in
    /// `startOffsetMs` order per `meeting-rpc.ts`'s own doc comment), and every `Speaker` row
    /// clustering has produced for it so far.
    public func getMeeting(meetingId: String) async throws -> (meeting: RPCMeeting, segments: [RPCTranscriptSegmentRecord], speakers: [RPCSpeaker]) {
        let result = try await rpc("getMeeting", ["meetingId": .string(meetingId)])
        return (
            meeting: try RPCMeeting(result.field("meeting")),
            segments: try (result.field("segments").arrayValue ?? []).map(RPCTranscriptSegmentRecord.init),
            speakers: try (result.field("speakers").arrayValue ?? []).map(RPCSpeaker.init)
        )
    }

    /// `role` gate: `"use"`. Lists this workspace's `Meeting` rows (lightweight — no transcript/
    /// speaker payload, matching `ListChatsOutput`'s identical "list is light, get is the full
    /// aggregate" split, `meeting-rpc.ts`'s own doc comment).
    public func listMeetings() async throws -> [RPCMeeting] {
        let result = try await rpc("listMeetings", [:])
        return try (result.field("meetings").arrayValue ?? []).map(RPCMeeting.init)
    }
}
