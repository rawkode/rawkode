import Foundation

/// Mirrors `packages/domain/src/tag.ts`'s `Tag` — supertags, multi-parent DAG:
/// `{id, name, parentIds[], builtin}`.
public struct Tag: Codable, Hashable, Sendable {
    public let id: EntityId
    public let name: String
    public let parentIds: [EntityId]
    public let builtin: Bool

    public init(id: EntityId, name: String, parentIds: [EntityId], builtin: Bool) {
        self.id = id
        self.name = name
        self.parentIds = parentIds
        self.builtin = builtin
    }
}

/// Mirrors `tag.ts`'s `BaseTagIds` exactly: literal nil-pattern UUIDs
/// `00000000-0000-0000-0000-00000000000N` for N = 1..8, in the plan's listed order (Person,
/// Organization, Company, Event, Place, Area, Project, Task). See that file's doc comment for the
/// full ID-scheme rationale — reproduced here verbatim, not re-derived, since the backend seeds
/// these same literal IDs at workspace-creation time and a client-side mismatch would be silent data
/// corruption, not a caught error.
public enum BaseTagIds {
    public static let person: EntityId = "00000000-0000-0000-0000-000000000001"
    public static let organization: EntityId = "00000000-0000-0000-0000-000000000002"
    public static let company: EntityId = "00000000-0000-0000-0000-000000000003"
    public static let event: EntityId = "00000000-0000-0000-0000-000000000004"
    public static let place: EntityId = "00000000-0000-0000-0000-000000000005"
    public static let area: EntityId = "00000000-0000-0000-0000-000000000006"
    public static let project: EntityId = "00000000-0000-0000-0000-000000000007"
    public static let task: EntityId = "00000000-0000-0000-0000-000000000008"
}

/// Mirrors `tag.ts`'s `BASE_TAGS`: the 8 Base Tags, seeded once at workspace creation as immutable
/// `builtin: true` rows. None have parents — the Base Tags are the roots of the supertag DAG.
public let BASE_TAGS: [Tag] = [
    Tag(id: BaseTagIds.person, name: "Person", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.organization, name: "Organization", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.company, name: "Company", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.event, name: "Event", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.place, name: "Place", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.area, name: "Area", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.project, name: "Project", parentIds: [], builtin: true),
    Tag(id: BaseTagIds.task, name: "Task", parentIds: [], builtin: true)
]
