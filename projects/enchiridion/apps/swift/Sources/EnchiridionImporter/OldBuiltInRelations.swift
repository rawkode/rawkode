// OldBuiltInRelations.swift
// EnchiridionImporter
//
// Mirrors the OLD app's `BuiltInRelations.propertyKey(for:)`
// (apps/enchiridion/Sources/EnchiridionCore/GraphOntology.swift:138-161) —
// the inverse lookup from a stored `KnowledgeEdge.relationID` back to the
// `(supertagID, fieldID)` it materializes. `OldPageDocumentDecoder` needs
// this to fold decoded old edges back into `.page(...)` property values,
// matching exactly what the old app's own `PageDocument.metadataProjection`
// already did at read time — so the DECODE step reproduces the old app's own
// property/edge duality faithfully, before `PageReencoder` ever gets
// involved.
//
// Deliberately a local, standalone port (not a call into the old app's own
// GraphOntology.swift) — this importer target does not depend on the old
// app's Swift package at all (see this package's Package.swift comment on
// why: that package pulls in GRDB/CloudKit/EventKit/etc., which the
// importer has no use for and shouldn't need to link against just to read
// twelve relation-id strings).
//
// NOT the new app's `EnchiridionCore.BuiltInRelations` — that type's
// fallback-only synthetic scheme (`property-relation:<tag>:<field>`) is what
// `PageDocument.setProperty` in EnchiridionSync uses when RE-ENCODING (see
// `PageReencoder.swift`); this type is what the DECODE step needs to
// understand the OLD app's richer table of named relation ids
// (`"person.organization"`, `"task.project"`, ...) it might encounter in an
// old vault's `edges` map. The two tables happen to share the exact same
// synthetic fallback format (`property-relation:<tag>:<field>`) — confirmed
// by reading both GraphOntology.swift's `default:` case and the new
// `BuiltInRelations.relationID(for:)`'s doc comment — which is exactly why
// round-tripping through `.page(...)` property values (rather than trying to
// carry the old named relation id itself across) is correct: the new side
// independently regenerates ITS OWN edge, and for any field this importer
// doesn't have an old named mapping for, both sides already agree on the
// synthetic fallback string.
import EnchiridionCore

public enum OldBuiltInRelations {
  /// `relationID` is the raw string off a decoded `KnowledgeEdge.relationID`
  /// (`EnchiridionCore.RelationID.rawValue`) — plain `String` here rather
  /// than that type, since this table only ever compares strings.
  public static func propertyKey(for relationID: String) -> SupertagPropertyKey? {
    switch relationID {
    case "person.organization":
      return .init(supertagID: .init(rawValue: "person"), fieldID: .init(rawValue: "organization"))
    case "project.area":
      return .init(supertagID: .init(rawValue: "project"), fieldID: .init(rawValue: "area"))
    case "project.owners":
      return .init(supertagID: .init(rawValue: "project"), fieldID: .init(rawValue: "owner"))
    case "project.organization":
      return .init(supertagID: .init(rawValue: "project"), fieldID: .init(rawValue: "organization"))
    case "project.place":
      return .init(supertagID: .init(rawValue: "project"), fieldID: .init(rawValue: "place"))
    case "task.project":
      return .init(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "project"))
    case "task.area":
      return .init(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "area"))
    case "task.parent":
      return .init(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "parent"))
    case "task.assignees":
      return .init(supertagID: .init(rawValue: "task"), fieldID: .init(rawValue: "assignee"))
    case "event.organizer":
      return .init(supertagID: .init(rawValue: "event"), fieldID: .init(rawValue: "organizer"))
    case "event.attendees":
      return .init(supertagID: .init(rawValue: "event"), fieldID: .init(rawValue: "attendees"))
    case "event.place":
      return .init(supertagID: .init(rawValue: "event"), fieldID: .init(rawValue: "place"))
    default:
      // The generic synthetic fallback both apps' `relationID(for:)`
      // functions independently produce for any entityReference field with
      // no named relation above — see this file's header.
      guard relationID.hasPrefix("property-relation:") else { return nil }
      let parts = relationID.split(separator: ":", omittingEmptySubsequences: false)
      guard parts.count == 3 else { return nil }
      return .init(
        supertagID: .init(rawValue: String(parts[1])),
        fieldID: .init(rawValue: String(parts[2]))
      )
    }
  }
}
