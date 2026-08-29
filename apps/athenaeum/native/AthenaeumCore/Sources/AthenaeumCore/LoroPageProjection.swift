import Foundation
import AthenaeumDomain
import Loro

/// Immutable, content-safe representation of the supported v1 ProseMirror subset.
/// No Loro handles, container identifiers, attributes, wire bytes, or unknown type names escape
/// this boundary. User-authored text is the only raw document content intentionally retained.
public indirect enum LoroPageProjectionNode: Sendable, Equatable {
    case document([LoroPageProjectionNode])
    case paragraph([LoroPageProjectionNode])
    case heading(level: Int, children: [LoroPageProjectionNode])
    case text(String, marks: [LoroPageProjectionMark])
    case unsupported
}

/// Sanitized presentation semantics only. In particular, `.link` never includes a URL and
/// `.unsupported` never includes a mark name or attributes such as entity/tag identifiers.
public enum LoroPageProjectionMark: String, Sendable, Equatable {
    case strong
    case emphasis
    case code
    case link
    case unsupported
}

public struct LoroPageRouteWitness: Sendable, Equatable {
    public let nodeId: EntityId
    public let format: PageDocumentFormat
    public let storageVersion: Int
    public let schemaVersion: Int
    public let snapshotSHA256: String

    public init(nodeId: EntityId, format: PageDocumentFormat, storageVersion: Int, schemaVersion: Int, snapshotSHA256: String) {
        self.nodeId = nodeId
        self.format = format
        self.storageVersion = storageVersion
        self.schemaVersion = schemaVersion
        self.snapshotSHA256 = snapshotSHA256
    }
}

public struct LoroPageReplicaWitness: Sendable, Equatable {
    public let snapshotSHA256: String
    public let versionVectorSHA256: String

    public init(snapshotSHA256: String, versionVectorSHA256: String) {
        self.snapshotSHA256 = snapshotSHA256
        self.versionVectorSHA256 = versionVectorSHA256
    }
}

public struct LoroPageProjection: Sendable, Equatable {
    public let root: LoroPageProjectionNode
    public let route: LoroPageRouteWitness
    public let replica: LoroPageReplicaWitness
    public let schemaVersion: Int
    public let isDirty: Bool

    public init(root: LoroPageProjectionNode, route: LoroPageRouteWitness, replica: LoroPageReplicaWitness, schemaVersion: Int, isDirty: Bool) {
        self.root = root
        self.route = route
        self.replica = replica
        self.schemaVersion = schemaVersion
        self.isDirty = isDirty
    }
}

public enum LoroPageProjectionError: Error, Sendable, Equatable {
    case pageNotPublished(EntityId)
    case malformedKnownContent
    case limitExceeded
}

/// Versioned, fixed caps for importing and traversing untrusted Loro material. The public
/// initializer intentionally exposes only the production policy; the internal initializer is a
/// test seam for exercising every boundary without constructing multi-megabyte fixtures.
public struct LoroPageProjectionLimits: Sendable, Equatable {
    public static let currentVersion = 1

    public let version: Int
    public let maxSnapshotBytes: Int
    public let maxUpdateBytes: Int
    public let maxVersionVectorBytes: Int
    public let maxDepth: Int
    public let maxNodes: Int
    public let maxChildren: Int
    public let maxTextRuns: Int
    public let maxMarks: Int
    public let maxAttributes: Int
    public let maxUTF8Bytes: Int

    public init() {
        self.init(
            version: Self.currentVersion,
            maxSnapshotBytes: 4 * 1024 * 1024,
            maxUpdateBytes: 4 * 1024 * 1024,
            maxVersionVectorBytes: 64 * 1024,
            maxDepth: 32,
            maxNodes: 10_000,
            maxChildren: 2_000,
            maxTextRuns: 10_000,
            maxMarks: 16,
            maxAttributes: 64,
            maxUTF8Bytes: 1_000_000
        )
    }

    init(
        version: Int,
        maxSnapshotBytes: Int,
        maxUpdateBytes: Int,
        maxVersionVectorBytes: Int,
        maxDepth: Int,
        maxNodes: Int,
        maxChildren: Int,
        maxTextRuns: Int,
        maxMarks: Int,
        maxAttributes: Int,
        maxUTF8Bytes: Int
    ) {
        precondition(version > 0)
        precondition(maxSnapshotBytes > 0 && maxUpdateBytes > 0 && maxVersionVectorBytes > 0)
        precondition(maxDepth >= 0 && maxNodes > 0 && maxChildren >= 0)
        precondition(maxTextRuns >= 0 && maxMarks >= 0 && maxAttributes >= 0 && maxUTF8Bytes >= 0)
        self.version = version
        self.maxSnapshotBytes = maxSnapshotBytes
        self.maxUpdateBytes = maxUpdateBytes
        self.maxVersionVectorBytes = maxVersionVectorBytes
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.maxChildren = maxChildren
        self.maxTextRuns = maxTextRuns
        self.maxMarks = maxMarks
        self.maxAttributes = maxAttributes
        self.maxUTF8Bytes = maxUTF8Bytes
    }
}

/// Only `doc`, `paragraph`, and `heading` have a native structural interpretation today. Every
/// other named map is deliberately represented as one bounded generic placeholder.
private enum LoroKnownPageNode: String {
    case document = "doc"
    case paragraph
    case heading
    case blockquote
    case horizontalRule = "horizontal_rule"
    case codeBlock = "code_block"
    case orderedList = "ordered_list"
    case bulletList = "bullet_list"
    case taskList = "task_list"
    case listItem = "list_item"
    case taskItem = "task_item"
    case unknownBlock
    case unknownLeaf
}

struct LoroPageProjector {
    let limits: LoroPageProjectionLimits
    private var nodes = 0
    private var textRuns = 0
    private var utf8Bytes = 0

    mutating func project(_ doc: LoroDoc) throws -> LoroPageProjectionNode {
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        return try node(root, depth: 0, requiredName: LoroKnownPageNode.document.rawValue)
    }

    private mutating func node(_ map: LoroMap, depth: Int, requiredName: String? = nil) throws -> LoroPageProjectionNode {
        guard depth <= limits.maxDepth else { throw LoroPageProjectionError.limitExceeded }
        nodes += 1
        guard nodes <= limits.maxNodes else { throw LoroPageProjectionError.limitExceeded }

        guard case .string(let name)? = map.get(key: "nodeName")?.asValue() else {
            if requiredName != nil { throw LoroPageProjectionError.malformedKnownContent }
            return try opaqueNode(map)
        }
        guard requiredName == nil || name == requiredName else {
            throw LoroPageProjectionError.malformedKnownContent
        }
        guard let kind = LoroKnownPageNode(rawValue: name) else {
            return try opaqueNode(map)
        }

        // Supported nodes must have the canonical container shape. A malformed supported node
        // never degrades into an apparently valid forward-compatible placeholder.
        guard let attributes = map.get(key: "attributes")?.asLoroMap(),
              let children = map.get(key: "children")?.asLoroList() else {
            throw LoroPageProjectionError.malformedKnownContent
        }
        guard Int(attributes.len()) <= limits.maxAttributes,
              Int(children.len()) <= limits.maxChildren else {
            throw LoroPageProjectionError.limitExceeded
        }

        try validateAttributes(attributes, for: kind)
        switch kind {
        case .document:
            guard children.len() > 0 else { throw LoroPageProjectionError.malformedKnownContent }
            var projected: [LoroPageProjectionNode] = []
            for index in 0..<children.len() {
                guard let child = children.get(index: index), let childMap = child.asLoroMap() else {
                    throw LoroPageProjectionError.malformedKnownContent
                }
                guard let childName = nodeName(childMap), childName.isBlock else {
                    throw LoroPageProjectionError.malformedKnownContent
                }
                projected.append(try node(childMap, depth: depth + 1))
            }
            return .document(projected)

        case .paragraph:
            return .paragraph(try inlineChildren(children, depth: depth))

        case .heading:
            guard case .i64(let rawLevel)? = attributes.get(key: "level")?.asValue(),
                  (1...3).contains(Int(rawLevel)) else {
                throw LoroPageProjectionError.malformedKnownContent
            }
            return .heading(level: Int(rawLevel), children: try inlineChildren(children, depth: depth))
        case .blockquote:
            _ = try blockChildren(children, depth: depth, required: true)
            return .unsupported
        case .unknownBlock:
            let projected = try blockChildren(children, depth: depth, required: true)
            // This is the single server-owned block the Worker writes for meeting preparation.
            // Its children are still projected through the normal known-node policy; every other
            // unknown block remains opaque to native clients.
            return isMeetingPreparationBlock(attributes) ? .document(projected) : .unsupported
        case .horizontalRule, .unknownLeaf:
            guard children.len() == 0 else { throw LoroPageProjectionError.malformedKnownContent }
            return .unsupported
        case .codeBlock:
            try unmarkedTextChildren(children)
            return .unsupported
        case .orderedList, .bulletList:
            try listChildren(children, depth: depth, item: .listItem)
            return .unsupported
        case .taskList:
            try listChildren(children, depth: depth, item: .taskItem)
            return .unsupported
        case .listItem, .taskItem:
            try listItemChildren(children, depth: depth)
            return .unsupported
        }
    }

    /// Unknown maps are never recursively decoded or surfaced by name. We inspect only container
    /// counts before returning the bounded placeholder so adversarial unknown structures cannot
    /// bypass the traversal policy.
    private mutating func opaqueNode(_ map: LoroMap) throws -> LoroPageProjectionNode {
        if let attributes = map.get(key: "attributes")?.asLoroMap(), Int(attributes.len()) > limits.maxAttributes {
            throw LoroPageProjectionError.limitExceeded
        }
        if let children = map.get(key: "children")?.asLoroList(), Int(children.len()) > limits.maxChildren {
            throw LoroPageProjectionError.limitExceeded
        }
        return .unsupported
    }

    private mutating func inlineChildren(_ children: LoroList, depth: Int) throws -> [LoroPageProjectionNode] {
        var projected: [LoroPageProjectionNode] = []
        for index in 0..<children.len() {
            guard let child = children.get(index: index) else {
                throw LoroPageProjectionError.malformedKnownContent
            }
            if let text = child.asLoroText() {
                projected.append(contentsOf: try textNodes(text))
            } else if let map = child.asLoroMap() {
                guard nodeName(map) == .unknownLeaf else { throw LoroPageProjectionError.malformedKnownContent }
                _ = try node(map, depth: depth + 1)
                projected.append(.unsupported)
            } else {
                throw LoroPageProjectionError.malformedKnownContent
            }
        }
        return projected
    }

    private mutating func textNodes(_ text: LoroText) throws -> [LoroPageProjectionNode] {
        // Check the full text container before materializing its delta across the FFI boundary.
        let textBytes = Int(text.lenUtf8())
        guard textBytes <= limits.maxUTF8Bytes - utf8Bytes else {
            throw LoroPageProjectionError.limitExceeded
        }
        utf8Bytes += textBytes

        var output: [LoroPageProjectionNode] = []
        for part in text.toDelta() {
            guard case .insert(let value, let attributes) = part else { continue }
            textRuns += 1
            guard textRuns <= limits.maxTextRuns else {
                throw LoroPageProjectionError.limitExceeded
            }
            let keys: Set<String> = attributes.map { Set($0.keys) } ?? []
            guard keys.count <= limits.maxAttributes,
                  keys.count <= limits.maxMarks else {
                throw LoroPageProjectionError.limitExceeded
            }

            var marks: [LoroPageProjectionMark] = []
            if keys.contains("strong") || keys.contains("bold") { marks.append(.strong) }
            if keys.contains("em") || keys.contains("italic") { marks.append(.emphasis) }
            if keys.contains("code") { marks.append(.code) }
            if keys.contains("link") { marks.append(.link) }

            try validateMarks(attributes ?? [:])
            let supportedMarkKeys: Set<String> = ["strong", "em", "code", "link"]
            if !keys.isSubset(of: supportedMarkKeys) { marks.append(.unsupported) }
            output.append(.text(value, marks: marks))
        }
        return output
    }

    private func nodeName(_ map: LoroMap) -> LoroKnownPageNode? {
        guard case .string(let name)? = map.get(key: "nodeName")?.asValue() else { return nil }
        return LoroKnownPageNode(rawValue: name)
    }

    private func validateAttributes(_ attributes: LoroMap, for kind: LoroKnownPageNode) throws {
        var allowed: Set<String> = ["isAmgBlock", "unknownAttrs"]
        switch kind {
        case .heading: allowed.insert("level")
        case .orderedList: allowed.insert("order")
        case .taskItem: allowed.insert("checked")
        case .unknownBlock: allowed.formUnion(["unknownParentBlock", "unknownBlock"])
        case .unknownLeaf: allowed.insert("unknownBlock")
        default: break
        }
        for key in attributes.keys() {
            guard allowed.contains(key), attributes.get(key: key)?.asLoroText() == nil else {
                throw LoroPageProjectionError.malformedKnownContent
            }
        }
        if let value = attributes.get(key: "isAmgBlock"), case .bool = deepValue(value) {} else if attributes.get(key: "isAmgBlock") != nil { throw LoroPageProjectionError.malformedKnownContent }
        if let value = attributes.get(key: "unknownAttrs"), !isRecordOrNull(value) { throw LoroPageProjectionError.malformedKnownContent }
        if kind == .orderedList, let value = attributes.get(key: "order"), case .i64(let order) = deepValue(value), order >= 1 {} else if kind == .orderedList, attributes.get(key: "order") != nil { throw LoroPageProjectionError.malformedKnownContent }
        if kind == .taskItem, let value = attributes.get(key: "checked"), case .bool = deepValue(value) {} else if kind == .taskItem, attributes.get(key: "checked") != nil { throw LoroPageProjectionError.malformedKnownContent }
        if kind == .unknownBlock, let value = attributes.get(key: "unknownParentBlock"), isStringOrNull(deepValue(value)) {} else if kind == .unknownBlock, attributes.get(key: "unknownParentBlock") != nil { throw LoroPageProjectionError.malformedKnownContent }
        if (kind == .unknownBlock || kind == .unknownLeaf), let value = attributes.get(key: "unknownBlock"), !isCompatibilityBlockMarkerOrNull(deepValue(value)) { throw LoroPageProjectionError.malformedKnownContent }
    }

    /// Attributes may be materialized as either scalar values or attached Loro containers.
    /// Validate their complete deep representation, never their container identity.
    private func deepValue(_ value: ValueOrContainer) -> LoroValue {
        if let scalar = value.asValue() { return scalar }
        if let map = value.asLoroMap() { return map.getDeepValue() }
        if let list = value.asLoroList() { return list.getDeepValue() }
        return .container(value: value.asContainer()!)
    }
    private func isRecordOrNull(_ value: ValueOrContainer) -> Bool {
        if case .map(let record) = deepValue(value) { return record.values.allSatisfy(isJSON) }
        if case .null = deepValue(value) { return true }
        return false
    }
    private func isJSON(_ value: LoroValue) -> Bool {
        switch value {
        case .null, .bool, .string: return true
        case .double(let value): return value.isFinite
        case .i64: return true
        case .list(let values): return values.allSatisfy(isJSON)
        case .map(let values): return values.values.allSatisfy(isJSON)
        case .binary, .container: return false
        }
    }
    private func isStringOrNull(_ value: LoroValue) -> Bool {
        if case .string = value { return true }
        if case .null = value { return true }
        return false
    }
    private func isCompatibilityReference(_ value: LoroValue) -> Bool {
        if case .string = value { return true }
        guard case .map(let object) = value, Set(object.keys) == ["val"], case .string? = object["val"] else { return false }
        return true
    }
    private func isCompatibilityBlockMarkerOrNull(_ value: LoroValue) -> Bool {
        if case .null = value { return true }
        guard case .map(let object) = value,
              Set(object.keys).isSubset(of: ["type", "parents", "attrs", "isEmbed"]),
              object["type"].map(isCompatibilityReference) == true,
              case .list(let parents)? = object["parents"], parents.allSatisfy(isCompatibilityReference),
              case .map(let attrs)? = object["attrs"], attrs.values.allSatisfy(isJSON) else { return false }
        if let isEmbed = object["isEmbed"], case .bool = isEmbed {} else if object["isEmbed"] != nil { return false }
        return true
    }

    private func isMeetingPreparationBlock(_ attributes: LoroMap) -> Bool {
        guard let marker = attributes.get(key: "unknownBlock"),
              case .map(let object) = deepValue(marker),
              let type = object["type"], compatibilityReferenceValue(type) == "athenaeum-meeting-prep",
              case .map(let attrs)? = object["attrs"],
              attrs["schemaVersion"] == .i64(value: 1),
              case .string? = attrs["localDate"],
              case .string? = attrs["occurrenceKey"] else { return false }
        return true
    }

    private func compatibilityReferenceValue(_ value: LoroValue) -> String? {
        if case .string(let value) = value { return value }
        guard case .map(let object) = value,
              Set(object.keys) == ["val"],
              case .string(let value)? = object["val"] else { return nil }
        return value
    }

    private mutating func blockChildren(_ children: LoroList, depth: Int, required: Bool) throws -> [LoroPageProjectionNode] {
        guard !required || children.len() > 0 else { throw LoroPageProjectionError.malformedKnownContent }
        var projected: [LoroPageProjectionNode] = []
        for index in 0..<children.len() {
            guard let map = children.get(index: index)?.asLoroMap(), let name = nodeName(map), name.isBlock else { throw LoroPageProjectionError.malformedKnownContent }
            projected.append(try node(map, depth: depth + 1))
        }
        return projected
    }
    private mutating func listChildren(_ children: LoroList, depth: Int, item: LoroKnownPageNode) throws {
        guard children.len() > 0 else { throw LoroPageProjectionError.malformedKnownContent }
        for index in 0..<children.len() {
            guard let map = children.get(index: index)?.asLoroMap(), nodeName(map) == item else { throw LoroPageProjectionError.malformedKnownContent }
            _ = try node(map, depth: depth + 1)
        }
    }
    private mutating func listItemChildren(_ children: LoroList, depth: Int) throws {
        guard let first = children.get(index: 0)?.asLoroMap(), nodeName(first) == .paragraph else { throw LoroPageProjectionError.malformedKnownContent }
        _ = try node(first, depth: depth + 1)
        for index in 1..<children.len() {
            guard let map = children.get(index: index)?.asLoroMap(), let name = nodeName(map), name.isBlock else { throw LoroPageProjectionError.malformedKnownContent }
            _ = try node(map, depth: depth + 1)
        }
    }
    private func unmarkedTextChildren(_ children: LoroList) throws {
        for index in 0..<children.len() {
            guard let text = children.get(index: index)?.asLoroText() else { throw LoroPageProjectionError.malformedKnownContent }
            for delta in text.toDelta() { if case .insert(_, let attributes) = delta, !(attributes ?? [:]).isEmpty { throw LoroPageProjectionError.malformedKnownContent } }
        }
    }
    private func validateMarks(_ attributes: [String: LoroValue]) throws {
        for (name, value) in attributes {
            guard case .map(let object) = value else { throw LoroPageProjectionError.malformedKnownContent }
            let keys = Set(object.keys)
            switch name {
            case "em", "strong", "code", "strike": guard keys.isEmpty else { throw LoroPageProjectionError.malformedKnownContent }
            case "link": guard keys.isSubset(of: ["href", "title"]), case .string? = object["href"], optionalStringOrNull(object["title"]) else { throw LoroPageProjectionError.malformedKnownContent }
            case "entityRef": guard keys.isSubset(of: ["nodeId", "label"]), case .string? = object["nodeId"], optionalString(object["label"]) else { throw LoroPageProjectionError.malformedKnownContent }
            case "supertagRef": guard keys.isSubset(of: ["tagId", "label"]), case .string? = object["tagId"], optionalString(object["label"]) else { throw LoroPageProjectionError.malformedKnownContent }
            case "unknownMark":
                guard keys.isSubset(of: ["unknownMarks"]),
                      (object["unknownMarks"] == nil || isRecordOrNull(object["unknownMarks"]!)) else {
                    throw LoroPageProjectionError.malformedKnownContent
                }
            default: throw LoroPageProjectionError.malformedKnownContent
            }
        }
    }
    private func optionalString(_ value: LoroValue?) -> Bool { value == nil || { if case .string = $0 { return true }; return false }(value!) }
    private func optionalStringOrNull(_ value: LoroValue?) -> Bool { value == nil || { if case .string = $0 { return true }; if case .null = $0 { return true }; return false }(value!) }
    private func isRecordOrNull(_ value: LoroValue) -> Bool {
        if case .map(let object) = value { return object.values.allSatisfy(isJSON) }
        if case .null = value { return true }
        return false
    }
}

private extension LoroKnownPageNode {
    var isBlock: Bool {
        switch self { case .paragraph, .unknownBlock, .heading, .blockquote, .horizontalRule, .codeBlock, .orderedList, .bulletList, .taskList: return true; default: return false }
    }
}
