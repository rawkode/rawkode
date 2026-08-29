import XCTest
@testable import AthenaeumDomain

/// Mirrors `packages/domain/src/rpc-error.test.ts`'s intent: `RpcErrorEnvelope` decodes real
/// `encodeRpcError`-produced fixtures, and `decodeRpcError` recovers the exact typed `DomainError`
/// on the other side — the full round trip risk #3's envelope convention depends on.
final class RpcErrorTests: XCTestCase {
    func testDecodeNodeNotFoundEnvelope() throws {
        let envelope = try decodeFixture(RpcErrorEnvelope.self, "RpcErrorEnvelope_NodeNotFound")
        XCTAssertEqual(envelope.tag, .nodeNotFound)
        let error = decodeRpcError(envelope)
        guard case .nodeNotFound(let nodeId) = error else {
            XCTFail("expected .nodeNotFound"); return
        }
        XCTAssertEqual(nodeId, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
    }

    func testDecodeValidationErrorEnvelope() throws {
        let envelope = try decodeFixture(RpcErrorEnvelope.self, "RpcErrorEnvelope_ValidationError")
        let error = decodeRpcError(envelope)
        guard case .validationError(let message, _) = error else {
            XCTFail("expected .validationError"); return
        }
        XCTAssertEqual(message, "title must not be empty")
    }

    func testDecodeGraphIssueDetectedEnvelope() throws {
        let envelope = try decodeFixture(RpcErrorEnvelope.self, "RpcErrorEnvelope_GraphIssueDetected")
        let error = decodeRpcError(envelope)
        guard case .graphIssueDetected(let relationDefinitionId, let nodeId, let conflictingEdgeIds) = error else {
            XCTFail("expected .graphIssueDetected"); return
        }
        XCTAssertEqual(relationDefinitionId, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e65")
        XCTAssertEqual(nodeId, "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
        XCTAssertEqual(conflictingEdgeIds.count, 2)
    }

    /// `encodeRpcError` (this package's Swift mirror) round-tripped through `decodeRpcError` must
    /// recover the exact original `DomainError`, for every tag — the same closed-set exhaustive
    /// coverage `rpc-error.test.ts` exercises against the TS pair.
    func testEncodeDecodeRoundTripsForEveryTag() {
        let samples: [DomainError] = [
            .nodeNotFound(nodeId: "n1"),
            .nodeAlreadyExists(nodeId: "n1"),
            .validationError(message: "bad input", cause: "some cause"),
            .validationError(message: "bad input", cause: nil),
            .unexpectedError(message: "boom"),
            .pageNotFound(nodeId: "n1"),
            .pageFormatMismatch(nodeId: "n1", expected: .loroV1, actual: .automergeV1),
            .loroSemanticCommitRequired(nodeId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"),
            .loroRequestIdentityConflict(nodeId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60", requestId: "semantic-commit"),
            .tagNotFound(tagId: "t1"),
            .factNotFound(factId: "f1"),
            .edgeNotFound(edgeId: "e1"),
            .relationDefinitionNotFound(relationDefinitionId: "r1"),
            .graphIssueNotFound(graphIssueId: "g1"),
            .cardinalityViolation(relationDefinitionId: "r1", message: "too many edges"),
            .graphIssueDetected(relationDefinitionId: "r1", nodeId: "n1", conflictingEdgeIds: ["e1", "e2"]),
            // Phase 5 native stage additions.
            .gatekeeperNotConnected(workspaceId: "v1", gatekeeperKind: "google-calendar"),
            .oauthExchangeFailed(message: "invalid_grant"),
            .observerVerificationFailed(observerId: "obs-1", message: "not a writer")
        ]
        for sample in samples {
            let envelope = encodeRpcError(sample)
            let recovered = decodeRpcError(envelope)
            XCTAssertEqual(recovered, sample, "round trip mismatch for \(sample)")
        }
    }

    func testEnvelopeItselfRoundTripsThroughJSON() throws {
        for name in [
            "RpcErrorEnvelope_NodeNotFound",
            "RpcErrorEnvelope_ValidationError",
            "RpcErrorEnvelope_GraphIssueDetected"
        ] {
            let envelope = try decodeFixture(RpcErrorEnvelope.self, name)
            try assertRoundTrips(envelope)
        }
    }

    /// `decodeRpcError(from:)`'s fail-closed contract: a malformed/unrecognized envelope throws
    /// rather than silently misdecoding (mirrors `decodeRpcError`'s `ParseError` path in TS).
    func testDecodeRpcErrorFromMalformedDataThrows() {
        let malformed = Data(#"{"tag":"SomeUnknownTag","message":"x","data":{}}"#.utf8)
        XCTAssertThrowsError(try decodeRpcError(from: malformed))
    }

    func testDecodeRpcErrorFromRealEnvelopeData() throws {
        let data = loadFixture("RpcErrorEnvelope_NodeNotFound")
        let error = try decodeRpcError(from: data)
        guard case .nodeNotFound = error else {
            XCTFail("expected .nodeNotFound"); return
        }
    }

    func testDecodeValidatedRpcErrorAcceptsOnlyCanonicalLoroSemanticCommitRequiredEnvelope() throws {
        let data = Data(#"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"}}"#.utf8)
        XCTAssertEqual(
            try decodeValidatedRpcError(data),
            .loroSemanticCommitRequired(nodeId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60")
        )
    }

    func testDecodeValidatedRpcErrorRejectsMalformedLoroSemanticCommitRequiredEnvelope() {
        let malformed = [
            #"{"tag":"LoroSemanticCommitRequired","message":"wrong","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"}}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{}}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"not-an-entity"}}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","content":"forbidden"}}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"},"content":"forbidden"}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"},"actor":"forbidden"}"#,
            #"{"tag":"LoroSemanticCommitRequired","message":"Loro page content updates must use commitLoroPageContent.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"},"bytes":"forbidden"}"#
        ]
        for raw in malformed {
            XCTAssertThrowsError(try decodeValidatedRpcError(Data(raw.utf8)))
            XCTAssertThrowsError(try decodeRpcError(from: Data(raw.utf8)))
        }
    }

    func testDecodeValidatedRpcErrorAcceptsOnlyCanonicalLoroRequestIdentityConflictEnvelope() throws {
        let data = Data(#"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":"semantic-commit"}}"#.utf8)
        XCTAssertEqual(
            try decodeValidatedRpcError(data),
            .loroRequestIdentityConflict(nodeId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60", requestId: "semantic-commit")
        )
    }

    func testDecodeValidatedRpcErrorRejectsMalformedLoroRequestIdentityConflictEnvelope() {
        let malformed = [
            #"{"tag":"LoroRequestIdentityConflict","message":"wrong","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":"semantic-commit"}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"not-an-entity","requestId":"semantic-commit"}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":" "}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":" semantic-commit "}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":"semantic-commit","bytes":"forbidden"}}"#,
            #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60","requestId":"semantic-commit"},"content":"forbidden"}"#
        ]
        for raw in malformed {
            XCTAssertThrowsError(try decodeValidatedRpcError(Data(raw.utf8)))
            XCTAssertThrowsError(try decodeRpcError(from: Data(raw.utf8)))
        }
    }

    func testLoroRequestIdentityConflictUsesTypeScriptUTF16RequestIdLimit() throws {
        let nodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"
        let accepted = String(repeating: "😀", count: 100)
        let rejected = String(repeating: "😀", count: 101)
        let valid = #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"\#(nodeId)","requestId":"\#(accepted)"}}"#
        let invalid = #"{"tag":"LoroRequestIdentityConflict","message":"Loro request identity was already used for a different command.","data":{"nodeId":"\#(nodeId)","requestId":"\#(rejected)"}}"#
        XCTAssertNoThrow(try decodeValidatedRpcError(Data(valid.utf8)))
        XCTAssertThrowsError(try decodeValidatedRpcError(Data(invalid.utf8)))
    }

    func testDecodeValidatedRpcErrorRejectsBOMWrappedLoroRequestIdentityConflictRequestId() {
        let nodeId = "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"
        for requestId in ["\u{FEFF}semantic", "semantic\u{FEFF}"] {
            let envelope: [String: Any] = [
                "tag": "LoroRequestIdentityConflict",
                "message": LORO_REQUEST_IDENTITY_CONFLICT_MESSAGE,
                "data": ["nodeId": nodeId, "requestId": requestId]
            ]
            let raw = try! JSONSerialization.data(withJSONObject: envelope)
            XCTAssertThrowsError(try decodeValidatedRpcError(raw))
        }
    }
}
