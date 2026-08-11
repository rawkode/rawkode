// GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `packages/codegen`'s `generateSwiftSchema()` (packages/codegen/src/index.ts)
// from the `dev.rawkode.enchiridion.core` supertag module (see `supertags/*`). Regenerate with:
//
//   bun run --cwd packages/codegen generate
//
// which writes every registered module's output into
// apps/swift/Sources/EnchiridionSchema/Generated/ (packages/codegen/scripts/generate.ts).
// See apps/swift/Sources/EnchiridionSchema/README.md and the plan's §Supertag module
// contract ("Swift learns the schema at runtime first ... The generated
// EnchiridionSchema ... is a compile-time convenience layered on top, not a
// prerequisite.").

import EnchiridionCore
import Foundation

/// Field ID constants `dev.rawkode.enchiridion.core.person` (`Person`) declares itself — does NOT include
/// inherited fields (see `CorePersonFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CorePersonFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.person")

  public static let email = SupertagFieldID(rawValue: "email")
  public static let phone = SupertagFieldID(rawValue: "phone")
  public static let organization = SupertagFieldID(rawValue: "organization")
  public static let role = SupertagFieldID(rawValue: "role")
  public static let birthday = SupertagFieldID(rawValue: "birthday")
  public static let relationshipNotes = SupertagFieldID(rawValue: "relationship-notes")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.person`
/// (`Person`) — includes Person's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CorePersonFields: Hashable, Sendable {
  public static let supertagID = CorePersonFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var email: [String] {
    get { SupertagFieldStorage.readEmailArray(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.email) }
    set { SupertagFieldStorage.writeEmailArray(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.email, newValue) }
  }

  public var phone: [String] {
    get { SupertagFieldStorage.readPhoneArray(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.phone) }
    set { SupertagFieldStorage.writePhoneArray(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.phone, newValue) }
  }

  public var organization: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.organization) }
    set { SupertagFieldStorage.writePage(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.organization, newValue) }
  }

  public var role: String? {
    get { SupertagFieldStorage.readText(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.role) }
    set { SupertagFieldStorage.writeText(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.role, newValue) }
  }

  public var birthday: Date? {
    get { SupertagFieldStorage.readDate(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.birthday) }
    set { SupertagFieldStorage.writeDate(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.birthday, newValue) }
  }

  public var relationshipNotes: String? {
    get { SupertagFieldStorage.readText(metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.relationshipNotes) }
    set { SupertagFieldStorage.writeText(&metadata, CorePersonFieldIDs.supertagID, CorePersonFieldIDs.relationshipNotes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.person` (`Person`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CorePerson: Codable, Hashable, Sendable {
  public var id: PageID
  public var email: [String]
  public var phone: [String]
  public var organization: PageID?
  public var role: String?
  public var birthday: Date?
  public var relationshipNotes: String?

  public init(
    id: PageID,
    email: [String] = [],
    phone: [String] = [],
    organization: PageID? = nil,
    role: String? = nil,
    birthday: Date? = nil,
    relationshipNotes: String? = nil
  ) {
    self.id = id
    self.email = email
    self.phone = phone
    self.organization = organization
    self.role = role
    self.birthday = birthday
    self.relationshipNotes = relationshipNotes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case email = "email"
    case phone = "phone"
    case organization = "organization"
    case role = "role"
    case birthday = "birthday"
    case relationshipNotes = "relationshipNotes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.email = try container.decodeIfPresent([String].self, forKey: .email) ?? []
    self.phone = try container.decodeIfPresent([String].self, forKey: .phone) ?? []
    self.organization = (try container.decodeIfPresent(String.self, forKey: .organization)).map { PageID(rawValue: $0) }
    self.role = try container.decodeIfPresent(String.self, forKey: .role)
    self.birthday = (try container.decodeIfPresent(Double.self, forKey: .birthday)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.relationshipNotes = try container.decodeIfPresent(String.self, forKey: .relationshipNotes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encode(email, forKey: .email)
    try container.encode(phone, forKey: .phone)
    try container.encodeIfPresent(organization?.rawValue, forKey: .organization)
    try container.encodeIfPresent(role, forKey: .role)
    try container.encodeIfPresent(birthday.map { $0.timeIntervalSince1970 * 1000 }, forKey: .birthday)
    try container.encodeIfPresent(relationshipNotes, forKey: .relationshipNotes)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.organization` (`Organization`) declares itself — does NOT include
/// inherited fields (see `CoreOrganizationFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreOrganizationFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.organization")

  public static let website = SupertagFieldID(rawValue: "website")
  public static let domain = SupertagFieldID(rawValue: "domain")
  public static let relationship = SupertagFieldID(rawValue: "relationship")
  public static let notes = SupertagFieldID(rawValue: "notes")
}

/// Select options for `dev.rawkode.enchiridion.core.organization`'s `relationship` field (`Relationship`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreOrganizationRelationship: String, Codable, Hashable, Sendable, CaseIterable {
  case prospect = "prospect"
  case active = "active"
  case partner = "partner"
  case former = "former"
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.organization`
/// (`Organization`) — includes Organization's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreOrganizationFields: Hashable, Sendable {
  public static let supertagID = CoreOrganizationFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var website: String? {
    get { SupertagFieldStorage.readURL(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.website) }
    set { SupertagFieldStorage.writeURL(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.website, newValue) }
  }

  public var domain: String? {
    get { SupertagFieldStorage.readText(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.domain) }
    set { SupertagFieldStorage.writeText(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.domain, newValue) }
  }

  public var relationship: CoreOrganizationRelationship? {
    get { SupertagFieldStorage.readSelect(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.relationship) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.relationship, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.notes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.organization` (`Organization`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreOrganization: Codable, Hashable, Sendable {
  public var id: PageID
  public var website: String?
  public var domain: String?
  public var relationship: CoreOrganizationRelationship?
  public var notes: String?

  public init(
    id: PageID,
    website: String? = nil,
    domain: String? = nil,
    relationship: CoreOrganizationRelationship? = nil,
    notes: String? = nil
  ) {
    self.id = id
    self.website = website
    self.domain = domain
    self.relationship = relationship
    self.notes = notes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case website = "website"
    case domain = "domain"
    case relationship = "relationship"
    case notes = "notes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.website = try container.decodeIfPresent(String.self, forKey: .website)
    self.domain = try container.decodeIfPresent(String.self, forKey: .domain)
    self.relationship = (try container.decodeIfPresent(String.self, forKey: .relationship)).flatMap { CoreOrganizationRelationship(rawValue: $0) }
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(website, forKey: .website)
    try container.encodeIfPresent(domain, forKey: .domain)
    try container.encodeIfPresent(relationship?.rawValue, forKey: .relationship)
    try container.encodeIfPresent(notes, forKey: .notes)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.company` (`Company`) declares itself — does NOT include
/// inherited fields (see `CoreCompanyFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreCompanyFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.company")

  public static let registrationNumber = SupertagFieldID(rawValue: "registration-number")
  public static let industry = SupertagFieldID(rawValue: "industry")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.company`
/// (`Company`) — includes Company's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreCompanyFields: Hashable, Sendable {
  public static let supertagID = CoreCompanyFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var website: String? {
    get { SupertagFieldStorage.readURL(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.website) }
    set { SupertagFieldStorage.writeURL(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.website, newValue) }
  }

  public var domain: String? {
    get { SupertagFieldStorage.readText(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.domain) }
    set { SupertagFieldStorage.writeText(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.domain, newValue) }
  }

  public var relationship: CoreOrganizationRelationship? {
    get { SupertagFieldStorage.readSelect(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.relationship) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.relationship, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CoreOrganizationFieldIDs.supertagID, CoreOrganizationFieldIDs.notes, newValue) }
  }

  public var registrationNumber: String? {
    get { SupertagFieldStorage.readText(metadata, CoreCompanyFieldIDs.supertagID, CoreCompanyFieldIDs.registrationNumber) }
    set { SupertagFieldStorage.writeText(&metadata, CoreCompanyFieldIDs.supertagID, CoreCompanyFieldIDs.registrationNumber, newValue) }
  }

  public var industry: String? {
    get { SupertagFieldStorage.readText(metadata, CoreCompanyFieldIDs.supertagID, CoreCompanyFieldIDs.industry) }
    set { SupertagFieldStorage.writeText(&metadata, CoreCompanyFieldIDs.supertagID, CoreCompanyFieldIDs.industry, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.company` (`Company`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreCompany: Codable, Hashable, Sendable {
  public var id: PageID
  public var website: String?
  public var domain: String?
  public var relationship: CoreOrganizationRelationship?
  public var notes: String?
  public var registrationNumber: String?
  public var industry: String?

  public init(
    id: PageID,
    website: String? = nil,
    domain: String? = nil,
    relationship: CoreOrganizationRelationship? = nil,
    notes: String? = nil,
    registrationNumber: String? = nil,
    industry: String? = nil
  ) {
    self.id = id
    self.website = website
    self.domain = domain
    self.relationship = relationship
    self.notes = notes
    self.registrationNumber = registrationNumber
    self.industry = industry
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case website = "website"
    case domain = "domain"
    case relationship = "relationship"
    case notes = "notes"
    case registrationNumber = "registrationNumber"
    case industry = "industry"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.website = try container.decodeIfPresent(String.self, forKey: .website)
    self.domain = try container.decodeIfPresent(String.self, forKey: .domain)
    self.relationship = (try container.decodeIfPresent(String.self, forKey: .relationship)).flatMap { CoreOrganizationRelationship(rawValue: $0) }
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
    self.registrationNumber = try container.decodeIfPresent(String.self, forKey: .registrationNumber)
    self.industry = try container.decodeIfPresent(String.self, forKey: .industry)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(website, forKey: .website)
    try container.encodeIfPresent(domain, forKey: .domain)
    try container.encodeIfPresent(relationship?.rawValue, forKey: .relationship)
    try container.encodeIfPresent(notes, forKey: .notes)
    try container.encodeIfPresent(registrationNumber, forKey: .registrationNumber)
    try container.encodeIfPresent(industry, forKey: .industry)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.event` (`Event`) declares itself — does NOT include
/// inherited fields (see `CoreEventFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreEventFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.event")

  public static let start = SupertagFieldID(rawValue: "start")
  public static let end = SupertagFieldID(rawValue: "end")
  public static let allDay = SupertagFieldID(rawValue: "all-day")
  public static let calendar = SupertagFieldID(rawValue: "calendar")
  public static let source = SupertagFieldID(rawValue: "source")
  public static let location = SupertagFieldID(rawValue: "location")
  public static let organizer = SupertagFieldID(rawValue: "organizer")
  public static let attendees = SupertagFieldID(rawValue: "attendees")
  public static let place = SupertagFieldID(rawValue: "place")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.event`
/// (`Event`) — includes Event's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreEventFields: Hashable, Sendable {
  public static let supertagID = CoreEventFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var start: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.start) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.start, newValue) }
  }

  public var end: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.end) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.end, newValue) }
  }

  public var allDay: Bool? {
    get { SupertagFieldStorage.readBoolean(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.allDay) }
    set { SupertagFieldStorage.writeBoolean(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.allDay, newValue) }
  }

  public var calendar: String? {
    get { SupertagFieldStorage.readText(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.calendar) }
    set { SupertagFieldStorage.writeText(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.calendar, newValue) }
  }

  public var source: String? {
    get { SupertagFieldStorage.readText(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.source) }
    set { SupertagFieldStorage.writeText(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.source, newValue) }
  }

  public var location: String? {
    get { SupertagFieldStorage.readText(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.location) }
    set { SupertagFieldStorage.writeText(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.location, newValue) }
  }

  public var organizer: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.organizer) }
    set { SupertagFieldStorage.writePage(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.organizer, newValue) }
  }

  public var attendees: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.attendees) }
    set { SupertagFieldStorage.writePageArray(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.attendees, newValue) }
  }

  public var place: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.place) }
    set { SupertagFieldStorage.writePage(&metadata, CoreEventFieldIDs.supertagID, CoreEventFieldIDs.place, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.event` (`Event`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreEvent: Codable, Hashable, Sendable {
  public var id: PageID
  public var start: Date?
  public var end: Date?
  public var allDay: Bool?
  public var calendar: String?
  public var source: String?
  public var location: String?
  public var organizer: PageID?
  public var attendees: [PageID]
  public var place: PageID?

  public init(
    id: PageID,
    start: Date? = nil,
    end: Date? = nil,
    allDay: Bool? = nil,
    calendar: String? = nil,
    source: String? = nil,
    location: String? = nil,
    organizer: PageID? = nil,
    attendees: [PageID] = [],
    place: PageID? = nil
  ) {
    self.id = id
    self.start = start
    self.end = end
    self.allDay = allDay
    self.calendar = calendar
    self.source = source
    self.location = location
    self.organizer = organizer
    self.attendees = attendees
    self.place = place
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case start = "start"
    case end = "end"
    case allDay = "allDay"
    case calendar = "calendar"
    case source = "source"
    case location = "location"
    case organizer = "organizer"
    case attendees = "attendees"
    case place = "place"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.start = (try container.decodeIfPresent(Double.self, forKey: .start)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.end = (try container.decodeIfPresent(Double.self, forKey: .end)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.allDay = try container.decodeIfPresent(Bool.self, forKey: .allDay)
    self.calendar = try container.decodeIfPresent(String.self, forKey: .calendar)
    self.source = try container.decodeIfPresent(String.self, forKey: .source)
    self.location = try container.decodeIfPresent(String.self, forKey: .location)
    self.organizer = (try container.decodeIfPresent(String.self, forKey: .organizer)).map { PageID(rawValue: $0) }
    self.attendees = (try container.decodeIfPresent([String].self, forKey: .attendees) ?? []).map { PageID(rawValue: $0) }
    self.place = (try container.decodeIfPresent(String.self, forKey: .place)).map { PageID(rawValue: $0) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(start.map { $0.timeIntervalSince1970 * 1000 }, forKey: .start)
    try container.encodeIfPresent(end.map { $0.timeIntervalSince1970 * 1000 }, forKey: .end)
    try container.encodeIfPresent(allDay, forKey: .allDay)
    try container.encodeIfPresent(calendar, forKey: .calendar)
    try container.encodeIfPresent(source, forKey: .source)
    try container.encodeIfPresent(location, forKey: .location)
    try container.encodeIfPresent(organizer?.rawValue, forKey: .organizer)
    try container.encode(attendees.map { $0.rawValue }, forKey: .attendees)
    try container.encodeIfPresent(place?.rawValue, forKey: .place)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.area` (`Area`) declares itself — does NOT include
/// inherited fields (see `CoreAreaFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreAreaFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.area")

  public static let status = SupertagFieldID(rawValue: "status")
  public static let notes = SupertagFieldID(rawValue: "notes")
}

/// Select options for `dev.rawkode.enchiridion.core.area`'s `status` field (`Status`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreAreaStatus: String, Codable, Hashable, Sendable, CaseIterable {
  case active = "active"
  case onHold = "on-hold"
  case archived = "archived"
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.area`
/// (`Area`) — includes Area's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreAreaFields: Hashable, Sendable {
  public static let supertagID = CoreAreaFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var status: CoreAreaStatus? {
    get { SupertagFieldStorage.readSelect(metadata, CoreAreaFieldIDs.supertagID, CoreAreaFieldIDs.status) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreAreaFieldIDs.supertagID, CoreAreaFieldIDs.status, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CoreAreaFieldIDs.supertagID, CoreAreaFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CoreAreaFieldIDs.supertagID, CoreAreaFieldIDs.notes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.area` (`Area`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreArea: Codable, Hashable, Sendable {
  public var id: PageID
  public var status: CoreAreaStatus?
  public var notes: String?

  public init(
    id: PageID,
    status: CoreAreaStatus? = nil,
    notes: String? = nil
  ) {
    self.id = id
    self.status = status
    self.notes = notes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case status = "status"
    case notes = "notes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.status = (try container.decodeIfPresent(String.self, forKey: .status)).flatMap { CoreAreaStatus(rawValue: $0) }
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(status?.rawValue, forKey: .status)
    try container.encodeIfPresent(notes, forKey: .notes)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.project` (`Project`) declares itself — does NOT include
/// inherited fields (see `CoreProjectFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreProjectFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.project")

  public static let status = SupertagFieldID(rawValue: "status")
  public static let outcome = SupertagFieldID(rawValue: "outcome")
  public static let area = SupertagFieldID(rawValue: "area")
  public static let owner = SupertagFieldID(rawValue: "owner")
  public static let organization = SupertagFieldID(rawValue: "organization")
  public static let startDate = SupertagFieldID(rawValue: "start-date")
  public static let dueDate = SupertagFieldID(rawValue: "due-date")
  public static let lastReviewedAt = SupertagFieldID(rawValue: "last-reviewed-at")
  public static let closedAt = SupertagFieldID(rawValue: "closed-at")
  public static let place = SupertagFieldID(rawValue: "place")
  public static let notes = SupertagFieldID(rawValue: "notes")
}

/// Select options for `dev.rawkode.enchiridion.core.project`'s `status` field (`Status`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreProjectStatus: String, Codable, Hashable, Sendable, CaseIterable {
  case idea = "idea"
  case planned = "planned"
  case active = "active"
  case onHold = "on-hold"
  case completed = "completed"
  case cancelled = "cancelled"
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.project`
/// (`Project`) — includes Project's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreProjectFields: Hashable, Sendable {
  public static let supertagID = CoreProjectFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var status: CoreProjectStatus? {
    get { SupertagFieldStorage.readSelect(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.status) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.status, newValue) }
  }

  public var outcome: String? {
    get { SupertagFieldStorage.readText(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.outcome) }
    set { SupertagFieldStorage.writeText(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.outcome, newValue) }
  }

  public var area: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.area) }
    set { SupertagFieldStorage.writePage(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.area, newValue) }
  }

  public var owner: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.owner) }
    set { SupertagFieldStorage.writePageArray(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.owner, newValue) }
  }

  public var organization: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.organization) }
    set { SupertagFieldStorage.writePage(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.organization, newValue) }
  }

  public var startDate: Date? {
    get { SupertagFieldStorage.readDate(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.startDate) }
    set { SupertagFieldStorage.writeDate(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.startDate, newValue) }
  }

  public var dueDate: Date? {
    get { SupertagFieldStorage.readDate(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.dueDate) }
    set { SupertagFieldStorage.writeDate(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.dueDate, newValue) }
  }

  public var lastReviewedAt: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.lastReviewedAt) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.lastReviewedAt, newValue) }
  }

  public var closedAt: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.closedAt) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.closedAt, newValue) }
  }

  public var place: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.place) }
    set { SupertagFieldStorage.writePage(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.place, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CoreProjectFieldIDs.supertagID, CoreProjectFieldIDs.notes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.project` (`Project`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreProject: Codable, Hashable, Sendable {
  public var id: PageID
  public var status: CoreProjectStatus?
  public var outcome: String?
  public var area: PageID?
  public var owner: [PageID]
  public var organization: PageID?
  public var startDate: Date?
  public var dueDate: Date?
  public var lastReviewedAt: Date?
  public var closedAt: Date?
  public var place: PageID?
  public var notes: String?

  public init(
    id: PageID,
    status: CoreProjectStatus? = nil,
    outcome: String? = nil,
    area: PageID? = nil,
    owner: [PageID] = [],
    organization: PageID? = nil,
    startDate: Date? = nil,
    dueDate: Date? = nil,
    lastReviewedAt: Date? = nil,
    closedAt: Date? = nil,
    place: PageID? = nil,
    notes: String? = nil
  ) {
    self.id = id
    self.status = status
    self.outcome = outcome
    self.area = area
    self.owner = owner
    self.organization = organization
    self.startDate = startDate
    self.dueDate = dueDate
    self.lastReviewedAt = lastReviewedAt
    self.closedAt = closedAt
    self.place = place
    self.notes = notes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case status = "status"
    case outcome = "outcome"
    case area = "area"
    case owner = "owner"
    case organization = "organization"
    case startDate = "startDate"
    case dueDate = "dueDate"
    case lastReviewedAt = "lastReviewedAt"
    case closedAt = "closedAt"
    case place = "place"
    case notes = "notes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.status = (try container.decodeIfPresent(String.self, forKey: .status)).flatMap { CoreProjectStatus(rawValue: $0) }
    self.outcome = try container.decodeIfPresent(String.self, forKey: .outcome)
    self.area = (try container.decodeIfPresent(String.self, forKey: .area)).map { PageID(rawValue: $0) }
    self.owner = (try container.decodeIfPresent([String].self, forKey: .owner) ?? []).map { PageID(rawValue: $0) }
    self.organization = (try container.decodeIfPresent(String.self, forKey: .organization)).map { PageID(rawValue: $0) }
    self.startDate = (try container.decodeIfPresent(Double.self, forKey: .startDate)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.dueDate = (try container.decodeIfPresent(Double.self, forKey: .dueDate)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.lastReviewedAt = (try container.decodeIfPresent(Double.self, forKey: .lastReviewedAt)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.closedAt = (try container.decodeIfPresent(Double.self, forKey: .closedAt)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.place = (try container.decodeIfPresent(String.self, forKey: .place)).map { PageID(rawValue: $0) }
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(status?.rawValue, forKey: .status)
    try container.encodeIfPresent(outcome, forKey: .outcome)
    try container.encodeIfPresent(area?.rawValue, forKey: .area)
    try container.encode(owner.map { $0.rawValue }, forKey: .owner)
    try container.encodeIfPresent(organization?.rawValue, forKey: .organization)
    try container.encodeIfPresent(startDate.map { $0.timeIntervalSince1970 * 1000 }, forKey: .startDate)
    try container.encodeIfPresent(dueDate.map { $0.timeIntervalSince1970 * 1000 }, forKey: .dueDate)
    try container.encodeIfPresent(lastReviewedAt.map { $0.timeIntervalSince1970 * 1000 }, forKey: .lastReviewedAt)
    try container.encodeIfPresent(closedAt.map { $0.timeIntervalSince1970 * 1000 }, forKey: .closedAt)
    try container.encodeIfPresent(place?.rawValue, forKey: .place)
    try container.encodeIfPresent(notes, forKey: .notes)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.task` (`Task`) declares itself — does NOT include
/// inherited fields (see `CoreTaskFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CoreTaskFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.task")

  public static let status = SupertagFieldID(rawValue: "status")
  public static let placement = SupertagFieldID(rawValue: "placement")
  public static let scheduled = SupertagFieldID(rawValue: "scheduled")
  public static let scheduleGranularity = SupertagFieldID(rawValue: "schedule-granularity")
  public static let deadline = SupertagFieldID(rawValue: "deadline")
  public static let reminder = SupertagFieldID(rawValue: "reminder")
  public static let project = SupertagFieldID(rawValue: "project")
  public static let area = SupertagFieldID(rawValue: "area")
  public static let parent = SupertagFieldID(rawValue: "parent")
  public static let assignee = SupertagFieldID(rawValue: "assignee")
  public static let tags = SupertagFieldID(rawValue: "tags")
  public static let priority = SupertagFieldID(rawValue: "priority")
  public static let recurrence = SupertagFieldID(rawValue: "recurrence")
  public static let estimatedMinutes = SupertagFieldID(rawValue: "estimated-minutes")
  public static let completedAt = SupertagFieldID(rawValue: "completed-at")
  public static let due = SupertagFieldID(rawValue: "due")
  public static let notes = SupertagFieldID(rawValue: "notes")
}

/// Select options for `dev.rawkode.enchiridion.core.task`'s `status` field (`Status`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreTaskStatus: String, Codable, Hashable, Sendable, CaseIterable {
  case toDo = "to-do"
  case inProgress = "in-progress"
  case blocked = "blocked"
  case done = "done"
  case cancelled = "cancelled"
}

/// Select options for `dev.rawkode.enchiridion.core.task`'s `placement` field (`List`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreTaskPlacement: String, Codable, Hashable, Sendable, CaseIterable {
  case inbox = "inbox"
  case anytime = "anytime"
  case someday = "someday"
}

/// Select options for `dev.rawkode.enchiridion.core.task`'s `schedule-granularity` field (`Schedule granularity`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreTaskScheduleGranularity: String, Codable, Hashable, Sendable, CaseIterable {
  case dateOnly = "date-only"
  case dateTime = "date-time"
}

/// Select options for `dev.rawkode.enchiridion.core.task`'s `priority` field (`Priority`). Case raw values are the field's stored
/// option ids exactly (slugified: lowercase, spaces -> hyphens — see
/// packages/schema/src/index.ts's `f.select()`), so this round-trips real stored data
/// unchanged.
public enum CoreTaskPriority: String, Codable, Hashable, Sendable, CaseIterable {
  case low = "low"
  case medium = "medium"
  case high = "high"
  case urgent = "urgent"
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.task`
/// (`Task`) — includes Task's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CoreTaskFields: Hashable, Sendable {
  public static let supertagID = CoreTaskFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var status: CoreTaskStatus? {
    get { SupertagFieldStorage.readSelect(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.status) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.status, newValue) }
  }

  public var placement: CoreTaskPlacement? {
    get { SupertagFieldStorage.readSelect(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.placement) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.placement, newValue) }
  }

  public var scheduled: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.scheduled) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.scheduled, newValue) }
  }

  public var scheduleGranularity: CoreTaskScheduleGranularity? {
    get { SupertagFieldStorage.readSelect(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.scheduleGranularity) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.scheduleGranularity, newValue) }
  }

  public var deadline: Date? {
    get { SupertagFieldStorage.readDate(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.deadline) }
    set { SupertagFieldStorage.writeDate(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.deadline, newValue) }
  }

  public var reminder: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.reminder) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.reminder, newValue) }
  }

  public var project: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.project) }
    set { SupertagFieldStorage.writePage(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.project, newValue) }
  }

  public var area: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.area) }
    set { SupertagFieldStorage.writePage(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.area, newValue) }
  }

  public var parent: PageID? {
    get { SupertagFieldStorage.readPage(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.parent) }
    set { SupertagFieldStorage.writePage(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.parent, newValue) }
  }

  public var assignee: [PageID] {
    get { SupertagFieldStorage.readPageArray(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.assignee) }
    set { SupertagFieldStorage.writePageArray(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.assignee, newValue) }
  }

  public var tags: [String] {
    get { SupertagFieldStorage.readTextArray(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.tags) }
    set { SupertagFieldStorage.writeTextArray(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.tags, newValue) }
  }

  public var priority: CoreTaskPriority? {
    get { SupertagFieldStorage.readSelect(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.priority) }
    set { SupertagFieldStorage.writeSelect(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.priority, newValue) }
  }

  public var recurrence: String? {
    get { SupertagFieldStorage.readText(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.recurrence) }
    set { SupertagFieldStorage.writeText(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.recurrence, newValue) }
  }

  public var estimatedMinutes: Double? {
    get { SupertagFieldStorage.readNumber(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.estimatedMinutes) }
    set { SupertagFieldStorage.writeNumber(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.estimatedMinutes, newValue) }
  }

  public var completedAt: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.completedAt) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.completedAt, newValue) }
  }

  public var due: Date? {
    get { SupertagFieldStorage.readDateTime(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.due) }
    set { SupertagFieldStorage.writeDateTime(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.due, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CoreTaskFieldIDs.supertagID, CoreTaskFieldIDs.notes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.task` (`Task`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CoreTask: Codable, Hashable, Sendable {
  public var id: PageID
  public var status: CoreTaskStatus?
  public var placement: CoreTaskPlacement?
  public var scheduled: Date?
  public var scheduleGranularity: CoreTaskScheduleGranularity?
  public var deadline: Date?
  public var reminder: Date?
  public var project: PageID?
  public var area: PageID?
  public var parent: PageID?
  public var assignee: [PageID]
  public var tags: [String]
  public var priority: CoreTaskPriority?
  public var recurrence: String?
  public var estimatedMinutes: Double?
  public var completedAt: Date?
  public var due: Date?
  public var notes: String?

  public init(
    id: PageID,
    status: CoreTaskStatus? = nil,
    placement: CoreTaskPlacement? = nil,
    scheduled: Date? = nil,
    scheduleGranularity: CoreTaskScheduleGranularity? = nil,
    deadline: Date? = nil,
    reminder: Date? = nil,
    project: PageID? = nil,
    area: PageID? = nil,
    parent: PageID? = nil,
    assignee: [PageID] = [],
    tags: [String] = [],
    priority: CoreTaskPriority? = nil,
    recurrence: String? = nil,
    estimatedMinutes: Double? = nil,
    completedAt: Date? = nil,
    due: Date? = nil,
    notes: String? = nil
  ) {
    self.id = id
    self.status = status
    self.placement = placement
    self.scheduled = scheduled
    self.scheduleGranularity = scheduleGranularity
    self.deadline = deadline
    self.reminder = reminder
    self.project = project
    self.area = area
    self.parent = parent
    self.assignee = assignee
    self.tags = tags
    self.priority = priority
    self.recurrence = recurrence
    self.estimatedMinutes = estimatedMinutes
    self.completedAt = completedAt
    self.due = due
    self.notes = notes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case status = "status"
    case placement = "placement"
    case scheduled = "scheduled"
    case scheduleGranularity = "scheduleGranularity"
    case deadline = "deadline"
    case reminder = "reminder"
    case project = "project"
    case area = "area"
    case parent = "parent"
    case assignee = "assignee"
    case tags = "tags"
    case priority = "priority"
    case recurrence = "recurrence"
    case estimatedMinutes = "estimatedMinutes"
    case completedAt = "completedAt"
    case due = "due"
    case notes = "notes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.status = (try container.decodeIfPresent(String.self, forKey: .status)).flatMap { CoreTaskStatus(rawValue: $0) }
    self.placement = (try container.decodeIfPresent(String.self, forKey: .placement)).flatMap { CoreTaskPlacement(rawValue: $0) }
    self.scheduled = (try container.decodeIfPresent(Double.self, forKey: .scheduled)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.scheduleGranularity = (try container.decodeIfPresent(String.self, forKey: .scheduleGranularity)).flatMap { CoreTaskScheduleGranularity(rawValue: $0) }
    self.deadline = (try container.decodeIfPresent(Double.self, forKey: .deadline)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.reminder = (try container.decodeIfPresent(Double.self, forKey: .reminder)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.project = (try container.decodeIfPresent(String.self, forKey: .project)).map { PageID(rawValue: $0) }
    self.area = (try container.decodeIfPresent(String.self, forKey: .area)).map { PageID(rawValue: $0) }
    self.parent = (try container.decodeIfPresent(String.self, forKey: .parent)).map { PageID(rawValue: $0) }
    self.assignee = (try container.decodeIfPresent([String].self, forKey: .assignee) ?? []).map { PageID(rawValue: $0) }
    self.tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
    self.priority = (try container.decodeIfPresent(String.self, forKey: .priority)).flatMap { CoreTaskPriority(rawValue: $0) }
    self.recurrence = try container.decodeIfPresent(String.self, forKey: .recurrence)
    self.estimatedMinutes = try container.decodeIfPresent(Double.self, forKey: .estimatedMinutes)
    self.completedAt = (try container.decodeIfPresent(Double.self, forKey: .completedAt)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.due = (try container.decodeIfPresent(Double.self, forKey: .due)).map { Date(timeIntervalSince1970: $0 / 1000) }
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(status?.rawValue, forKey: .status)
    try container.encodeIfPresent(placement?.rawValue, forKey: .placement)
    try container.encodeIfPresent(scheduled.map { $0.timeIntervalSince1970 * 1000 }, forKey: .scheduled)
    try container.encodeIfPresent(scheduleGranularity?.rawValue, forKey: .scheduleGranularity)
    try container.encodeIfPresent(deadline.map { $0.timeIntervalSince1970 * 1000 }, forKey: .deadline)
    try container.encodeIfPresent(reminder.map { $0.timeIntervalSince1970 * 1000 }, forKey: .reminder)
    try container.encodeIfPresent(project?.rawValue, forKey: .project)
    try container.encodeIfPresent(area?.rawValue, forKey: .area)
    try container.encodeIfPresent(parent?.rawValue, forKey: .parent)
    try container.encode(assignee.map { $0.rawValue }, forKey: .assignee)
    try container.encode(tags, forKey: .tags)
    try container.encodeIfPresent(priority?.rawValue, forKey: .priority)
    try container.encodeIfPresent(recurrence, forKey: .recurrence)
    try container.encodeIfPresent(estimatedMinutes, forKey: .estimatedMinutes)
    try container.encodeIfPresent(completedAt.map { $0.timeIntervalSince1970 * 1000 }, forKey: .completedAt)
    try container.encodeIfPresent(due.map { $0.timeIntervalSince1970 * 1000 }, forKey: .due)
    try container.encodeIfPresent(notes, forKey: .notes)
  }
}

/// Field ID constants `dev.rawkode.enchiridion.core.place` (`Place`) declares itself — does NOT include
/// inherited fields (see `CorePlaceFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CorePlaceFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.place")

  public static let address = SupertagFieldID(rawValue: "address")
  public static let mapUrl = SupertagFieldID(rawValue: "map-url")
  public static let timeZone = SupertagFieldID(rawValue: "time-zone")
  public static let notes = SupertagFieldID(rawValue: "notes")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.core.place`
/// (`Place`) — includes Place's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CorePlaceFields: Hashable, Sendable {
  public static let supertagID = CorePlaceFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var address: String? {
    get { SupertagFieldStorage.readText(metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.address) }
    set { SupertagFieldStorage.writeText(&metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.address, newValue) }
  }

  public var mapUrl: String? {
    get { SupertagFieldStorage.readURL(metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.mapUrl) }
    set { SupertagFieldStorage.writeURL(&metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.mapUrl, newValue) }
  }

  public var timeZone: String? {
    get { SupertagFieldStorage.readText(metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.timeZone) }
    set { SupertagFieldStorage.writeText(&metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.timeZone, newValue) }
  }

  public var notes: String? {
    get { SupertagFieldStorage.readText(metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.notes) }
    set { SupertagFieldStorage.writeText(&metadata, CorePlaceFieldIDs.supertagID, CorePlaceFieldIDs.notes, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.core.place` (`Place`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CorePlace: Codable, Hashable, Sendable {
  public var id: PageID
  public var address: String?
  public var mapUrl: String?
  public var timeZone: String?
  public var notes: String?

  public init(
    id: PageID,
    address: String? = nil,
    mapUrl: String? = nil,
    timeZone: String? = nil,
    notes: String? = nil
  ) {
    self.id = id
    self.address = address
    self.mapUrl = mapUrl
    self.timeZone = timeZone
    self.notes = notes
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case address = "address"
    case mapUrl = "mapUrl"
    case timeZone = "timeZone"
    case notes = "notes"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.address = try container.decodeIfPresent(String.self, forKey: .address)
    self.mapUrl = try container.decodeIfPresent(String.self, forKey: .mapUrl)
    self.timeZone = try container.decodeIfPresent(String.self, forKey: .timeZone)
    self.notes = try container.decodeIfPresent(String.self, forKey: .notes)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(address, forKey: .address)
    try container.encodeIfPresent(mapUrl, forKey: .mapUrl)
    try container.encodeIfPresent(timeZone, forKey: .timeZone)
    try container.encodeIfPresent(notes, forKey: .notes)
  }
}
