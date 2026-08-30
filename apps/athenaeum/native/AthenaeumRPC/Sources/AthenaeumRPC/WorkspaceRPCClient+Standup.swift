import AthenaeumDomain
import Foundation

/// A privacy-safe error for the employee publication projection. The server's private authority
/// records and storage diagnostics never become part of a native error message.
public enum StandupPublicationRPCError: Error, Sendable, Equatable, LocalizedError {
    case malformedResponse

    public var errorDescription: String? { "Unable to load employee updates. Please try again." }
}

private let standupReferenceKinds: Set<String> = ["microEmployee", "job", "workflow", "schedule", "council"]

private func decodeStandupReference(_ value: CapnWebValue) throws -> StandupPublicationReference {
    guard let kind = try value.field("kind").stringValue,
          let id = try value.field("id").stringValue,
          let version = try value.field("version").stringValue,
          standupReferenceKinds.contains(kind),
          !id.isEmpty,
          !version.isEmpty else {
        throw StandupPublicationRPCError.malformedResponse
    }
    return StandupPublicationReference(kind: kind, id: id, version: version)
}

private func decodeStandupPublicationResultKind(_ value: CapnWebValue) throws -> StandupPublicationResultKind? {
    switch value {
    case .null, .undefined:
        return nil
    case .string(let rawValue):
        guard let resultKind = StandupPublicationResultKind(rawValue: rawValue) else {
            throw StandupPublicationRPCError.malformedResponse
        }
        return resultKind
    default:
        throw StandupPublicationRPCError.malformedResponse
    }
}

func decodeStandupPublication(_ value: CapnWebValue) throws -> StandupPublication {
    do {
        guard let id = try value.field("id").stringValue,
              let civilDate = try value.field("civilDate").stringValue,
              let microEmployeeLabel = try value.field("microEmployeeLabel").stringValue,
              let jobLabel = try value.field("jobLabel").stringValue,
              let workflowLabel = try value.field("workflowLabel").stringValue,
              let scheduleLabel = try value.field("scheduleLabel").stringValue,
              let originalText = try value.field("originalText").stringValue,
              let publishedAt = try value.field("publishedAt").stringValue,
              let childNodeId = try value.field("childNodeId").stringValue,
              let rawStatus = try value.field("companionStatus").stringValue,
              let status = StandupPublicationCompanionStatus(rawValue: rawStatus),
              let councilRefs = try value.field("councilRefs").arrayValue,
              !microEmployeeLabel.isEmpty,
              !jobLabel.isEmpty,
              !workflowLabel.isEmpty,
              !scheduleLabel.isEmpty,
              !originalText.isEmpty else {
            throw StandupPublicationRPCError.malformedResponse
        }
        _ = try LocalDate(validating: civilDate)
        return StandupPublication(
            id: try EntityId(validating: id),
            civilDate: civilDate,
            microEmployeeLabel: microEmployeeLabel,
            jobLabel: jobLabel,
            workflowLabel: workflowLabel,
            scheduleLabel: scheduleLabel,
            microEmployee: try decodeStandupReference(value.field("microEmployee")),
            job: try decodeStandupReference(value.field("job")),
            workflow: try decodeStandupReference(value.field("workflow")),
            schedule: try decodeStandupReference(value.field("schedule")),
            councilRefs: try councilRefs.map(decodeStandupReference),
            originalText: originalText,
            publishedAt: try IsoDateTimeString(validating: publishedAt),
            childNodeId: try EntityId(validating: childNodeId),
            companionStatus: status,
            resultKind: try decodeStandupPublicationResultKind(value.field("resultKind"))
        )
    } catch is StandupPublicationRPCError {
        throw StandupPublicationRPCError.malformedResponse
    } catch {
        throw StandupPublicationRPCError.malformedResponse
    }
}

extension WorkspaceRPCClient {
    /// Fetches the employee publication projection attached to one resolved daily note. The
    /// client sends only the note identity; private workforce authority material stays server-side.
    public func listStandupPublications(dailyNoteId: String) async throws -> [StandupPublication] {
        let nodeId = try EntityId(validating: dailyNoteId)
        do {
            let result = try await rpc("listStandupPublications", ["dailyNoteId": .string(nodeId.rawValue)])
            guard let publications = try result.field("publications").arrayValue else {
                throw StandupPublicationRPCError.malformedResponse
            }
            return try publications.map(decodeStandupPublication)
        } catch is StandupPublicationRPCError {
            throw StandupPublicationRPCError.malformedResponse
        }
    }
}
