import AthenaeumDomain
@testable import AthenaeumRPC
import Foundation
import XCTest

private final class GraphWireProtocol: URLProtocol {
    static var body = Data()
    static var response = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let body = request.httpBody {
            Self.body = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            var captured = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                captured.append(buffer, count: count)
            }
            stream.close()
            Self.body = captured
        } else { Self.body = Data() }
        let http = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.response)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class WorkspaceRPCClientGraphTests: XCTestCase {
    func testAppRunCredentialRequiresNonblankCredentialAndFutureISODate() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let future = "2023-11-14T22:14:00Z"
        let valid = try RPCAppRunCredential(
            .object(["credential": .string("app-capability"), "expiresAt": .string(future)]),
            now: now
        )
        XCTAssertEqual(valid.credential, "app-capability")
        XCTAssertEqual(valid.expiresAt, future)

        for malformed in [
            CapnWebValue.object(["credential": .string("  "), "expiresAt": .string(future)]),
            CapnWebValue.object(["credential": .string("app-capability"), "expiresAt": .string("not-a-date")]),
            CapnWebValue.object(["credential": .string("app-capability"), "expiresAt": .string("2023-11-14T22:12:59Z")])
        ] {
            XCTAssertThrowsError(try RPCAppRunCredential(malformed, now: now))
        }
    }

    func testMintAppRunCredentialUsesWorkspaceAndAppArguments() async throws {
        let response = try CapnWebValue.encodeMessageLine(["resolve", 1, CapnWebValue.object([
            "credential": .string("app-capability"),
            "expiresAt": .string("2099-01-01T00:00:00Z")
        ]).toWireJSON()])
        GraphWireProtocol.body = Data()
        GraphWireProtocol.response = Data(response.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GraphWireProtocol.self]
        let client = WorkspaceRPCClient(
            baseURL: URL(string: "http://apps-wire.invalid")!,
            workspaceId: "workspace-1",
            urlSession: URLSession(configuration: configuration)
        )
        let credential = try await client.mintAppRunCredential(appId: "app-1")
        XCTAssertEqual(credential.credential, "app-capability")
        let first = try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)?.split(separator: "\n").first)
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(first.utf8)) as? [Any])
        let pipeline = try XCTUnwrap(wire[1] as? [Any])
        XCTAssertEqual(pipeline[2] as? [String], ["mintAppRunCredential"])
        let args = try XCTUnwrap((try XCTUnwrap(pipeline[3] as? [Any]).first) as? [String: Any])
        XCTAssertEqual(args["workspaceId"] as? String, "workspace-1")
        XCTAssertEqual(args["appId"] as? String, "app-1")
    }

    func testAuthorityBearingTagReadRequiresCompleteValidatedTagAndLowercaseRevision() throws {
        let tag = CapnWebValue.object([
            "id": .string("00000000-0000-4000-8000-000000000501"),
            "name": .string("Project"),
            "parentIds": .array([.string("00000000-0000-4000-8000-000000000502")]),
            "builtin": .bool(false)
        ])
        let valid = try RPCTagRead(.object(["tag": tag, "revision": .string(String(repeating: "a", count: 64))]))
        XCTAssertEqual(valid.tag.parentIds, ["00000000-0000-4000-8000-000000000502"])
        XCTAssertThrowsError(try RPCTagRead(.object(["tag": tag, "revision": .string(String(repeating: "A", count: 64))])))
        let duplicate = CapnWebValue.object(["id": .string("00000000-0000-4000-8000-000000000501"), "name": .string("Project"), "parentIds": .array([.string("00000000-0000-4000-8000-000000000502"), .string("00000000-0000-4000-8000-000000000502")]), "builtin": .bool(false)])
        XCTAssertThrowsError(try RPCTagRead(.object(["tag": duplicate, "revision": .string(String(repeating: "a", count: 64))])))
        for malformed in [
            CapnWebValue.object(["id": .string("bad"), "name": .string("Project"), "parentIds": .array([]), "builtin": .bool(false)]),
            CapnWebValue.object(["id": .string("00000000-0000-4000-8000-000000000501"), "name": .string(" \u{00A0}"), "parentIds": .array([]), "builtin": .bool(false)]),
            CapnWebValue.object(["id": .string("00000000-0000-4000-8000-000000000501"), "name": .string("Project"), "parentIds": .array([.int(1)]), "builtin": .bool(false)]),
            CapnWebValue.object(["id": .string("00000000-0000-4000-8000-000000000501"), "name": .string("Project"), "builtin": .bool(false)])
        ] {
            XCTAssertThrowsError(try RPCTagRead(.object(["tag": malformed, "revision": .string(String(repeating: "a", count: 64))])))
        }
        let legacy = CapnWebValue.object(["id": .string("00000000-0000-4000-8000-000000000501"), "name": .string("\u{FB00} Cafe\u{301}"), "parentIds": .array([]), "builtin": .bool(false)])
        XCTAssertEqual(try RPCTagRead(.object(["tag": legacy, "revision": .string(String(repeating: "a", count: 64))])).tag.name, "\u{FB00} Cafe\u{301}")
    }

    func testGetAndUpdateTagUseRevisionFencedWireContract() async throws {
        let id = "00000000-0000-4000-8000-000000000511"
        let parent = "00000000-0000-4000-8000-000000000512"
        let tag = CapnWebValue.object(["id": .string(id), "name": .string("Project"), "parentIds": .array([.string(parent)]), "builtin": .bool(false)])
        let revision = String(repeating: "a", count: 64)
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, CapnWebValue.object(["tag": .object(["tag": tag, "revision": .string(revision)])]).toWireJSON()])
        GraphWireProtocol.response = Data(line.utf8)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [GraphWireProtocol.self]
        let client = WorkspaceRPCClient(baseURL: URL(string: "http://graph-wire.invalid")!, workspaceId: "workspace-1", urlSession: URLSession(configuration: config))
        _ = try await client.getTag(tagId: id)
        var wire = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)?.split(separator: "\n").first).utf8)) as! [Any]
        var pipeline = wire[1] as! [Any]
        XCTAssertEqual(pipeline[2] as? [String], ["getTag"])
        var args = ((pipeline[3] as! [Any])[0] as! [String: Any])
        XCTAssertEqual(args["workspaceId"] as? String, "workspace-1"); XCTAssertEqual(args["tagId"] as? String, id)
        _ = try await client.updateTag(tagId: id, expectedRevision: revision, name: "Project", parentIds: [parent], requestId: "req-1", commitMessage: "Update schema", attribution: .init(kind: "humanUi", surface: "ios-supertags"))
        wire = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)?.split(separator: "\n").first).utf8)) as! [Any]
        pipeline = wire[1] as! [Any]; XCTAssertEqual(pipeline[2] as? [String], ["updateTag"])
        args = ((pipeline[3] as! [Any])[0] as! [String: Any])
        XCTAssertEqual(args["workspaceId"] as? String, "workspace-1"); XCTAssertEqual(args["expectedRevision"] as? String, revision)
        XCTAssertTrue(try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)).contains(parent)); XCTAssertEqual(args["requestId"] as? String, "req-1")
    }

    func testApplySupertagPreservesLedgerIntentAndDecodesFacts() async throws {
        let fact = CapnWebValue.object([
            "id": .string("01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62"),
            "nodeId": .string("01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"),
            "predicateId": .string("role"),
            "value": .string("Engineer")
        ])
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, CapnWebValue.object([
            "nodeId": .string("01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60"),
            "tagId": .string("01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61"),
            "facts": .array([fact])
        ]).toWireJSON()])
        GraphWireProtocol.body = Data(); GraphWireProtocol.response = Data(line.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GraphWireProtocol.self]
        let client = WorkspaceRPCClient(baseURL: URL(string: "http://graph-wire.invalid")!, workspaceId: "workspace-1", urlSession: URLSession(configuration: configuration))
        let output = try await client.applySupertag(
            nodeId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e60",
            tagId: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61",
            requestId: "request-1",
            commitMessage: "Tag this note",
            attribution: .init(kind: "humanUi", surface: "macos"),
            fieldValues: [.init(fieldId: try EntityId(validating: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e63"), value: "Engineer")]
        )
        XCTAssertEqual(output.facts.count, 1)
        XCTAssertEqual(output.facts[0].predicateId, "role")
        let first = try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)?.split(separator: "\n").first)
        let wire = try JSONSerialization.jsonObject(with: Data(first.utf8)) as! [Any]
        let pipeline = try XCTUnwrap(wire[1] as? [Any])
        XCTAssertEqual(pipeline[2] as? [String], ["applySupertag"])
        let args = try XCTUnwrap((try XCTUnwrap(pipeline[3] as? [Any]).first) as? [String: Any])
        XCTAssertEqual(Set(args.keys), Set(["workspaceId", "nodeId", "tagId", "requestId", "commitMessage", "attribution", "fieldValues"]))
        XCTAssertEqual(args["requestId"] as? String, "request-1")
        XCTAssertEqual(args["commitMessage"] as? String, "Tag this note")
    }

    func testDefineTagFieldSendsExactArgumentsAndDecodesReceipt() async throws {
        let field = CapnWebValue.object(["id": .string("field-1"), "tagId": .string("tag-1"), "name": .string("Status"), "valueKind": .string("checkbox"), "sortOrder": .int(4), "builtin": .bool(false)])
        let line = try CapnWebValue.encodeMessageLine(["resolve", 1, CapnWebValue.object(["fieldDefinition": field]).toWireJSON()])
        GraphWireProtocol.body = Data(); GraphWireProtocol.response = Data(line.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [GraphWireProtocol.self]
        let client = WorkspaceRPCClient(baseURL: URL(string: "http://graph-wire.invalid")!, workspaceId: "workspace-1", urlSession: URLSession(configuration: configuration))
        let receipt = try await client.defineTagField(tagId: "tag-1", name: "Status", valueKind: .checkbox, sortOrder: 4, requestId: "request-1", commitMessage: "Record project state", attribution: MutationAttribution(kind: "humanUi", surface: "ios-supertags"))
        XCTAssertEqual(receipt.id, "field-1"); XCTAssertEqual(receipt.tagId, "tag-1"); XCTAssertEqual(receipt.valueKind, .checkbox)
        let first = try XCTUnwrap(String(data: GraphWireProtocol.body, encoding: .utf8)?.split(separator: "\n").first)
        let wire = try JSONSerialization.jsonObject(with: Data(first.utf8)) as! [Any]
        XCTAssertEqual(wire[0] as? String, "push")
        let pipeline = try XCTUnwrap(wire[1] as? [Any])
        XCTAssertEqual(pipeline[0] as? String, "pipeline")
        XCTAssertEqual(pipeline[1] as? Int, 0)
        XCTAssertEqual(pipeline[2] as? [String], ["defineTagField"])
        let positionalArgs = try XCTUnwrap(pipeline[3] as? [Any])
        XCTAssertEqual(positionalArgs.count, 1)
        let args = try XCTUnwrap(positionalArgs[0] as? [String: Any])
        XCTAssertEqual(Set(args.keys), Set(["workspaceId", "tagId", "name", "valueKind", "sortOrder", "requestId", "commitMessage", "attribution"]))
        XCTAssertEqual(args["workspaceId"] as? String, "workspace-1")
        XCTAssertEqual(args["tagId"] as? String, "tag-1")
        XCTAssertEqual(args["name"] as? String, "Status")
        XCTAssertEqual(args["valueKind"] as? String, "checkbox")
        XCTAssertEqual(args["sortOrder"] as? Int, 4)
        XCTAssertEqual(args["requestId"] as? String, "request-1")
        XCTAssertEqual(args["commitMessage"] as? String, "Record project state")
        let attribution = try XCTUnwrap(args["attribution"] as? [String: Any])
        XCTAssertEqual(Set(attribution.keys), Set(["version", "kind", "surface"]))
        XCTAssertEqual(attribution["version"] as? String, "athenaeum.mutation-attribution.v1")
        XCTAssertEqual(attribution["kind"] as? String, "humanUi")
        XCTAssertEqual(attribution["surface"] as? String, "ios-supertags")
    }
}
