// GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `packages/codegen`'s `generateSwiftSchema()` (packages/codegen/src/index.ts)
// from the `dev.rawkode.enchiridion.canvas` supertag module (see `supertags/*`). Regenerate with:
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

/// Field ID constants `dev.rawkode.enchiridion.canvas.canvasPage` (`Canvas`) declares itself — does NOT include
/// inherited fields (see `CanvasCanvaspageFields` below for those, which references each
/// inherited field's own owning-tag `FieldIDs` type directly).
public enum CanvasCanvaspageFieldIDs {
  public static let supertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.canvas.canvasPage")

  public static let width = SupertagFieldID(rawValue: "width")
  public static let height = SupertagFieldID(rawValue: "height")
}

/// Typed get/set accessor over a page's `PageObjectMetadata` for `dev.rawkode.enchiridion.canvas.canvasPage`
/// (`Canvas`) — includes Canvas's own fields plus every effectively-inherited
/// ancestor field (`SupertagRegistry.effectiveFields`).
///
/// Wraps `PageObjectMetadata`, NOT `PageDocument`: `EnchiridionSchema` depends only on
/// `EnchiridionCore`, not `EnchiridionSync` (where `PageDocument`/the CRDT doc actually
/// lives) — see this file's header for why. Reads here are real, live get accessors;
/// writes stage into `metadata.properties` in memory. A caller that can see both
/// `EnchiridionSchema` and `EnchiridionSync` (e.g. `EnchiridionUI`) persists a change by
/// passing `metadata.properties` (or the specific keys touched) to
/// `PageDocument.setProperty`/`setProperties`.
public struct CanvasCanvaspageFields: Hashable, Sendable {
  public static let supertagID = CanvasCanvaspageFieldIDs.supertagID

  public var metadata: PageObjectMetadata

  public init(metadata: PageObjectMetadata = PageObjectMetadata()) {
    self.metadata = metadata
  }

  public var width: Double? {
    get { SupertagFieldStorage.readNumber(metadata, CanvasCanvaspageFieldIDs.supertagID, CanvasCanvaspageFieldIDs.width) }
    set { SupertagFieldStorage.writeNumber(&metadata, CanvasCanvaspageFieldIDs.supertagID, CanvasCanvaspageFieldIDs.width, newValue) }
  }

  public var height: Double? {
    get { SupertagFieldStorage.readNumber(metadata, CanvasCanvaspageFieldIDs.supertagID, CanvasCanvaspageFieldIDs.height) }
    set { SupertagFieldStorage.writeNumber(&metadata, CanvasCanvaspageFieldIDs.supertagID, CanvasCanvaspageFieldIDs.height, newValue) }
  }
}

/// Typed GraphQL response shape for `dev.rawkode.enchiridion.canvas.canvasPage` (`Canvas`) — `Codable`, matching
/// `workers/vault/src/graphql/schema.ts`'s epoch-millisecond `Float` timestamp convention:
/// date/dateTime fields decode from a `Double` milliseconds-since-epoch value by hand
/// below (never via `JSONDecoder.dateDecodingStrategy`, which only handles a whole
/// decoder's uniform strategy, not a per-field wire convention).
///
/// Anticipatory: `graphql-composer`/vault's real Pothos schema for this supertag is a
/// concurrently-running P1 task and may not exist yet — field names here are this
/// generator's own convention (camelCase of each effective field id) and should be
/// reconciled with the real schema once vault's Pothos types for supertags land.
public struct CanvasCanvaspage: Codable, Hashable, Sendable {
  public var id: PageID
  public var width: Double?
  public var height: Double?

  public init(
    id: PageID,
    width: Double? = nil,
    height: Double? = nil
  ) {
    self.id = id
    self.width = width
    self.height = height
  }

  private enum CodingKeys: String, CodingKey {
    case id = "id"
    case width = "width"
    case height = "height"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = PageID(rawValue: try container.decode(String.self, forKey: .id))
    self.width = try container.decodeIfPresent(Double.self, forKey: .width)
    self.height = try container.decodeIfPresent(Double.self, forKey: .height)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id.rawValue, forKey: .id)
    try container.encodeIfPresent(width, forKey: .width)
    try container.encodeIfPresent(height, forKey: .height)
  }
}
