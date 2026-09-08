import AthenaeumDomain
import Foundation

private func requiredField(_ value: CapnWebValue, _ field: String) throws -> CapnWebValue {
    guard case .object(let fields) = value, let fieldValue = fields[field] else {
        throw CapnWebError.malformedMessage("missing \(field)")
    }
    return fieldValue
}

private func requiredString(_ value: CapnWebValue, _ field: String) throws -> String {
    guard let value = value.stringValue, !value.isEmpty else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
    return value
}

private func requiredBytes(_ value: CapnWebValue, _ field: String) throws -> Data {
    guard let value = value.bytesValue else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
    return value
}

private func requiredOrdinal(_ value: CapnWebValue) throws -> Int {
    guard case .number(let number) = value,
          number.isFinite,
          number >= 0,
          number.rounded(.towardZero) == number,
          let ordinal = Int(exactly: number),
          LoroWireSafeInteger.containsOrdinal(ordinal)
    else {
        throw CapnWebError.malformedMessage("missing/invalid ordinal")
    }
    return ordinal
}

private func requiredBool(_ value: CapnWebValue, _ field: String) throws -> Bool {
    guard let value = value.boolValue else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
    return value
}
private func requiredPositiveInt(_ value: CapnWebValue, _ field: String) throws -> Int {
    guard case .number(let value) = value,
          value.isFinite,
          value.rounded(.towardZero) == value,
          let integer = Int(exactly: value),
          LoroWireSafeInteger.contains(integer)
    else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
    return integer
}
private func requiredDigest(_ value: CapnWebValue, _ field: String) throws -> String {
    let value = try requiredString(value, field)
    guard LoroMutationWire.isDigest(value) else { throw CapnWebError.malformedMessage("missing/invalid \(field)") }
    return value
}
func loroAttributionValue(_ attribution: LoroMutationAttributionV1) -> CapnWebValue {
    switch attribution {
    case .humanUi(let surface): return .object(["version": .string("athenaeum.mutation-attribution.v1"), "kind": .string("humanUi"), "surface": .string(surface)])
    case .agentJob(let jobId, let runId): return .object(["version": .string("athenaeum.mutation-attribution.v1"), "kind": .string("agentJob"), "jobId": .string(jobId), "runId": .string(runId)])
    case .system(let source): return .object(["version": .string("athenaeum.mutation-attribution.v1"), "kind": .string("system"), "source": .string(source)])
    }
}

private func decodeLoroDescriptor(_ response: CapnWebValue, field: String = "descriptor") throws -> PageDocumentDescriptor {
    let descriptorValue = try requiredField(response, field)
    guard case .object = descriptorValue else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
    let descriptorData = try JSONSerialization.data(withJSONObject: descriptorValue.toWireJSON())
    let descriptor = try JSONDecoder().decode(PageDocumentDescriptor.self, from: descriptorData)
    guard descriptor.activeFormat == .loroV1 else {
        throw CapnWebError.malformedMessage("\(field) must be loro-v1")
    }
    return descriptor
}

func decodeLegacyPageProjectionResponse(_ response: CapnWebValue) throws -> GetLegacyPageProjectionOutput {
    let contentValue = try requiredField(response, "content")
    guard case .object = contentValue else {
        throw CapnWebError.malformedMessage("missing/invalid content")
    }
    let contentData = try JSONSerialization.data(withJSONObject: contentValue.toWireJSON())
    let content: LegacyPageProjectionContent
    do {
        content = try JSONDecoder().decode(LegacyPageProjectionContent.self, from: contentData)
    } catch {
        throw CapnWebError.malformedMessage("missing/invalid content")
    }
    let descriptorValue = try requiredField(response, "descriptor")
    let descriptorData = try JSONSerialization.data(withJSONObject: descriptorValue.toWireJSON())
    let descriptor = try JSONDecoder().decode(PageDocumentDescriptor.self, from: descriptorData)
    let readOnly = try requiredBool(requiredField(response, "readOnly"), "readOnly")
    let migrationRequired = try requiredBool(requiredField(response, "migrationRequired"), "migrationRequired")
    do {
        return try GetLegacyPageProjectionOutput(
            content: content,
            descriptor: descriptor,
            readOnly: readOnly,
            migrationRequired: migrationRequired
        )
    } catch {
        throw CapnWebError.malformedMessage("legacy projection must be read-only automerge-v1")
    }
}

func decodeMigrateLegacyPageResponse(_ response: CapnWebValue) throws -> MigrateLegacyPageOutput {
    MigrateLegacyPageOutput(descriptor: try decodeLoroDescriptor(response))
}

func decodeCommitLoroPageContentResponse(_ response: CapnWebValue) throws -> CommitLoroPageContentOutput {
    let descriptor = try decodeLoroDescriptor(response)
    let storageVersion = try requiredPositiveInt(requiredField(response, "storageVersion"), "storageVersion")
    guard descriptor.storageVersion == storageVersion else { throw CapnWebError.malformedMessage("descriptor storageVersion mismatch") }
    let resultSnapshotSHA256 = try requiredDigest(requiredField(response, "resultSnapshotSha256"), "resultSnapshotSha256")
    let descriptorSnapshotSHA256: String
    switch descriptor {
    case .legacy:
        throw CapnWebError.malformedMessage("commit receipt descriptor must be loro-v1")
    case .migratedLoro(_, _, _, let loro), .nativeLoro(_, _, let loro):
        descriptorSnapshotSHA256 = loro.snapshotSha256
    }
    guard LoroMutationWire.isDigest(descriptorSnapshotSHA256), descriptorSnapshotSHA256 == resultSnapshotSHA256 else {
        throw CapnWebError.malformedMessage("descriptor snapshot witness mismatch")
    }
    return try CommitLoroPageContentOutput(
        descriptor: descriptor,
        storageVersion: storageVersion,
        resultSnapshotSHA256: resultSnapshotSHA256,
        baseVersionVectorSHA256: try requiredDigest(requiredField(response, "baseVersionVectorSha256"), "baseVersionVectorSha256"),
        resultVersionVectorSHA256: try requiredDigest(requiredField(response, "resultVersionVectorSha256"), "resultVersionVectorSha256"),
        updateSHA256: try requiredDigest(requiredField(response, "updateSha256"), "updateSha256")
    )
}

func decodeStartLoroPageSyncResponse(_ response: CapnWebValue) throws -> StartLoroPageSyncOutput {
    StartLoroPageSyncOutput(
        sessionId: try requiredString(requiredField(response, "sessionId"), "sessionId"),
        message: try requiredBytes(requiredField(response, "message"), "message"),
        serverVersion: try requiredBytes(requiredField(response, "serverVersion"), "serverVersion")
    )
}

func decodeLoroPageSyncMessageResponse(_ response: CapnWebValue) throws -> LoroPageSyncMessageOutput {
    let updateValue = try requiredField(response, "update")
    let update = updateValue.isNull ? nil : try requiredBytes(updateValue, "update")
    return LoroPageSyncMessageOutput(
        sessionId: try requiredString(requiredField(response, "sessionId"), "sessionId"),
        ordinal: try requiredOrdinal(requiredField(response, "ordinal")),
        update: update,
        serverVersion: try requiredBytes(requiredField(response, "serverVersion"), "serverVersion"),
        converged: try requiredBool(requiredField(response, "converged"), "converged"),
        reset: try requiredBool(requiredField(response, "reset"), "reset")
    )
}

private func requireNonEmpty(_ value: String, _ field: String) throws {
    guard !value.isEmpty else {
        throw CapnWebError.malformedMessage("missing/invalid \(field)")
    }
}

public extension WorkspaceRPCClient {
    /// Server-derived migration transport. The complete source witness is bound into the receipt,
    /// while the server derives both target Loro bytes and schema from its authority.
    func migrateLegacyPage(_ input: MigrateLegacyPageInput) async throws -> MigrateLegacyPageOutput {
        guard input.workspaceId.rawValue == workspaceId else { throw LoroMutationWireError.workspaceMismatch }
        let result = try await rpc("migrateLegacyPage", [
            "nodeId": .string(input.nodeId.rawValue),
            "expectedStorageVersion": .int(input.expectedStorageVersion),
            "expectedAutomerge": .object([
                "docId": .string(input.expectedAutomerge.docId),
                "headsHash": .string(input.expectedAutomerge.headsHash),
                "bytesSha256": .string(input.expectedAutomerge.bytesSha256)
            ]),
            "intent": .object([
                "requestId": .string(input.intent.requestId),
                "commitMessage": .string(input.intent.commitMessage),
                "attribution": loroAttributionValue(input.intent.attribution)
            ])
        ])
        let output = try decodeMigrateLegacyPageResponse(result)
        guard output.descriptor.nodeId == input.nodeId else {
            throw CapnWebError.malformedMessage("migration receipt node mismatch")
        }
        switch output.descriptor {
        case .legacy:
            throw CapnWebError.malformedMessage("migration receipt descriptor must preserve Automerge witness")
        case .nativeLoro:
            throw CapnWebError.malformedMessage("migration receipt descriptor must preserve Automerge witness")
        case .migratedLoro(_, let storageVersion, let automerge, _):
            guard storageVersion > input.expectedStorageVersion else {
                throw CapnWebError.malformedMessage("migration receipt storageVersion must advance")
            }
            guard automerge == input.expectedAutomerge else {
                throw CapnWebError.malformedMessage("migration receipt Automerge witness mismatch")
            }
        }
        return output
    }

    /// Core-owned semantic commit transport. The raw update is deliberately unavailable to
    /// normal AppUI imports; the Core editor runtime is its sole planned caller.
    @_spi(AthenaeumCore) func commitLoroPageContent(_ input: CommitLoroPageContentInput) async throws -> CommitLoroPageContentOutput {
        guard input.workspaceId.rawValue == workspaceId else { throw LoroMutationWireError.workspaceMismatch }
        let result = try await rpc("commitLoroPageContent", [
            "nodeId": .string(input.nodeId.rawValue),
            "intent": .object(["requestId": .string(input.intent.requestId), "commitMessage": .string(input.intent.commitMessage), "attribution": loroAttributionValue(input.intent.attribution)]),
            "expectedStorageVersion": .int(input.expectedStorageVersion), "expectedSnapshotSha256": .string(input.expectedSnapshotSHA256),
            "expectedVersionVector": .bytes(input.expectedVersionVector), "update": .bytes(input.update)
        ])
        let receipt = try decodeCommitLoroPageContentResponse(result)
        guard receipt.descriptor.nodeId == input.nodeId else {
            throw CapnWebError.malformedMessage("commit receipt node mismatch")
        }
        guard receipt.baseVersionVectorSHA256 == input.expectedVersionVectorIdentitySHA256 else {
            throw CapnWebError.malformedMessage("commit receipt version-vector witness mismatch")
        }
        guard receipt.updateSHA256 == LoroMutationWire.sha256Hex(input.update) else {
            throw CapnWebError.malformedMessage("commit receipt update witness mismatch")
        }
        return receipt
    }
    func getPageDocumentDescriptor(nodeId: String) async throws -> PageDocumentDescriptor {
        try requireNonEmpty(nodeId, "nodeId")
        let result = try await rpc("getPageDocumentDescriptor", ["nodeId": .string(nodeId)])
        let data = try JSONSerialization.data(withJSONObject: try result.field("descriptor").toWireJSON())
        return try JSONDecoder().decode(PageDocumentDescriptor.self, from: data)
    }
    /// Returns only a flattened, read-only legacy view. This method deliberately has no legacy
    /// sync or mutation companion: callers must migrate on the server before editing as Loro.
    func getLegacyPageProjection(nodeId: String) async throws -> GetLegacyPageProjectionOutput {
        try requireNonEmpty(nodeId, "nodeId")
        let result = try await rpc("getLegacyPageProjection", ["nodeId": .string(nodeId)])
        let projection = try decodeLegacyPageProjectionResponse(result)
        guard projection.descriptor.nodeId.rawValue == nodeId else {
            throw CapnWebError.malformedMessage("legacy projection node mismatch")
        }
        return projection
    }
    func createLoroPage(nodeId: String, creationIntent: CreationIntent) async throws -> PageDocumentDescriptor {
        try requireNonEmpty(nodeId, "nodeId")
        try requireNonEmpty(creationIntent.requestId, "requestId")
        try requireNonEmpty(creationIntent.commitMessage.trimmingCharacters(in: .whitespacesAndNewlines), "commitMessage")
        let attribution: [String: CapnWebValue] = [
            "version": .string(creationIntent.attribution.version), "kind": .string(creationIntent.attribution.kind),
            "surface": creationIntent.attribution.surface.map(CapnWebValue.string) ?? .null,
            "jobId": creationIntent.attribution.jobId.map(CapnWebValue.string) ?? .null,
            "runId": creationIntent.attribution.runId.map(CapnWebValue.string) ?? .null,
            "source": creationIntent.attribution.source.map(CapnWebValue.string) ?? .null
        ]
        let result = try await rpc("createLoroPage", ["nodeId": .string(nodeId), "creationIntent": .object([
            "requestId": .string(creationIntent.requestId), "commitMessage": .string(creationIntent.commitMessage), "attribution": .object(attribution)
        ])])
        let data = try JSONSerialization.data(withJSONObject: try result.field("descriptor").toWireJSON())
        return try JSONDecoder().decode(PageDocumentDescriptor.self, from: data)
    }
    func startLoroPageSync(nodeId: String, sessionId: String) async throws -> StartLoroPageSyncOutput {
        try requireNonEmpty(nodeId, "nodeId")
        try requireNonEmpty(sessionId, "sessionId")
        let r = try await rpc("startLoroPageSync", ["nodeId": .string(nodeId), "sessionId": .string(sessionId)])
        return try decodeStartLoroPageSyncResponse(r)
    }
    /// Read-only Loro sync always sends an empty client frame. It is the only Loro sync method
    /// visible to normal imports, so UI code cannot transport an arbitrary local update.
    func loroPageReadSyncMessage(nodeId: String, sessionId: String, ordinal: Int, clientVersion: Data) async throws -> LoroPageSyncMessageOutput {
        try await loroPageSyncMessage(
            nodeId: nodeId,
            sessionId: sessionId,
            ordinal: ordinal,
            update: Data(),
            clientVersion: clientVersion
        )
    }

    /// Raw Loro frames are reserved for the Core-owned semantic checkpoint runtime. Normal
    /// consumers must use `loroPageReadSyncMessage`, which sends an empty frame itself.
    @_spi(AthenaeumCore) func loroPageSyncMessage(nodeId: String, sessionId: String, ordinal: Int, update: Data, clientVersion: Data) async throws -> LoroPageSyncMessageOutput {
        try requireNonEmpty(nodeId, "nodeId")
        try requireNonEmpty(sessionId, "sessionId")
        guard LoroWireSafeInteger.containsOrdinal(ordinal) else { throw CapnWebError.malformedMessage("ordinal must be a safe nonnegative integer") }
        let r = try await rpc("loroPageSyncMessage", ["nodeId": .string(nodeId), "sessionId": .string(sessionId), "ordinal": .int(ordinal), "update": .bytes(update), "clientVersion": .bytes(clientVersion)])
        return try decodeLoroPageSyncMessageResponse(r)
    }
}
