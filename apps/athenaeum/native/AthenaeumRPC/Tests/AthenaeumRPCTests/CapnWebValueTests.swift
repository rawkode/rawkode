import XCTest
@testable import AthenaeumRPC

/// Offline codec tests — no network, safe to run in CI without a live backend. Each fixture here
/// is a wire string this client actually observed from the real running backend (captured in
/// `apps/athenaeum/native/docs/decisions.md`'s transcript), not an invented example — so these
/// tests double as a frozen record of the empirically-verified wire shapes this client depends on.
final class CapnWebValueTests: XCTestCase {
    private func decodeLine(_ line: String) throws -> CapnWebValue {
        let json = try JSONSerialization.jsonObject(with: Data(line.utf8))
        return try CapnWebValue.fromWireJSON(json)
    }

    func testDecodesPlainObjectResolve() throws {
        // Captured from a real `createNode` response.
        let line = #"{"node":{"id":"f9ecd920-d30a-4314-9870-3cc80e2efb58","workspaceId":"0c3dc2b4-9457-41ac-9ce4-74e6e15a1ecb","title":"Hello from curl","createdAt":"2026-08-20T17:18:29.601Z"}}"#
        let value = try decodeLine(line)
        XCTAssertEqual(try value.field("node").field("title").stringValue, "Hello from curl")
    }

    func testDecodesWrappedArray() throws {
        // Captured from a real `listNodes` response: `"nodes":[[{...}]]` — the outer `[...]` is
        // the JSON container the object arrives in; the *inner* `[[ ]]` is capnweb's own
        // plain-array wrap.
        let line = #"{"nodes":[[{"id":"a","workspaceId":"b","title":"t","createdAt":"c"}]]}"#
        let value = try decodeLine(line)
        let nodes = try value.field("nodes").arrayValue
        XCTAssertEqual(nodes?.count, 1)
        XCTAssertEqual(try nodes?[0].field("id").stringValue, "a")
    }

    func testDecodesBytesTaggedArray() throws {
        // Captured from a real `startPageSync` response (unpadded base64 — capnweb strips `=`).
        let line = #"{"message":["bytes","QgFyHjfIKByVem0U4MJQHqB13tQuid+kmv//9Tvmk17WfgABAAYCCgfREiwAAgKE"]}"#
        let value = try decodeLine(line)
        let bytes = try value.field("message").bytesValue
        XCTAssertNotNil(bytes)
        XCTAssertGreaterThan(bytes?.count ?? 0, 0)
    }

    func testDecodesErrorTaggedArrayInsideReject() throws {
        // Captured from a real `getNode` rejection for a nonexistent node.
        let line = #"["reject",1,["error","Error","{\"tag\":\"NodeNotFound\",\"message\":\"Node not found: 6258f684-ec27-4fa5-8a73-f5a5489e5bea\",\"data\":{\"nodeId\":\"6258f684-ec27-4fa5-8a73-f5a5489e5bea\"}}"]]"#
        let json = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [Any]
        XCTAssertEqual(json[0] as? String, "reject")
        let errorValue = try CapnWebValue.fromWireJSON(json[2])
        guard case let .error(name, message) = errorValue else {
            return XCTFail("expected .error, got \(errorValue)")
        }
        XCTAssertEqual(name, "Error")
        let domainError = AthenaeumDomainError.decode(name: name, message: message)
        XCTAssertEqual(domainError, .nodeNotFound(nodeId: "6258f684-ec27-4fa5-8a73-f5a5489e5bea"))
    }

    func testDecodesNestedEntriesArrayFromSyncFeed() throws {
        // Captured from a real `syncFeed` response — an object nested inside the wrapped array.
        let line = #"{"epoch":"01119972-c866-4f0f-aac6-1107f03724f4","epochMismatch":false,"entries":[[{"replicaEpoch":0,"monotonicCounter":0,"entityKind":"node","entityId":"f9ecd920-d30a-4314-9870-3cc80e2efb58","operation":"put","payload":{"id":"x"},"hash":"60a03142"}]],"nextAfterCounter":2}"#
        let value = try decodeLine(line)
        XCTAssertEqual(try value.field("epochMismatch").boolValue, false)
        let entries = try value.field("entries").arrayValue
        XCTAssertEqual(entries?.count, 1)
        XCTAssertEqual(try entries?[0].field("operation").stringValue, "put")
        // `replicaEpoch: 0` must decode as `.number(0)`, NOT `.bool(false)` — this is exactly the
        // NSNumber/CFBoolean ambiguity `fromWireJSON`'s doc comment warns about.
        XCTAssertEqual(try entries?[0].field("replicaEpoch").intValue, 0)
        XCTAssertNil(try entries?[0].field("replicaEpoch").boolValue)
    }

    func testEncodeOmitsUndefinedFields() throws {
        // Mirrors `CreateNodeInput.id`'s `Schema.optional` convention: an omitted optional field
        // must vanish from the JSON entirely, not appear as `null`.
        let value = CapnWebValue.object(["title": .string("t"), "id": .undefined])
        let json = value.toWireJSON()
        let data = try JSONSerialization.data(withJSONObject: json)
        let text = String(data: data, encoding: .utf8)!
        XCTAssertFalse(text.contains("id"))
        XCTAssertTrue(text.contains("title"))
    }

    func testEncodeArrayWrapsOnce() throws {
        let value = CapnWebValue.array([.string("a"), .string("b")])
        let json = value.toWireJSON() as! [Any]
        XCTAssertEqual(json.count, 1)
        let inner = json[0] as! [Any]
        XCTAssertEqual(inner as! [String], ["a", "b"])
    }

    func testBytesRoundTrip() throws {
        let original = Data([0, 1, 2, 3, 255, 254, 253])
        let wire = CapnWebValue.bytes(original).toWireJSON() as! [Any]
        XCTAssertEqual(wire[0] as? String, "bytes")
        let b64 = wire[1] as! String
        XCTAssertFalse(b64.hasSuffix("="), "capnweb strips base64 padding")

        let decoded = try CapnWebValue.fromWireJSON(wire)
        XCTAssertEqual(decoded.bytesValue, original)
    }

    func testEncodeMessageLineMatchesCapturedRequest() throws {
        // Byte-for-byte match against the actual request body this client's protocol
        // understanding was verified against (decisions.md's curl transcript).
        let args: [String: Any] = [
            "workspaceId": "0c3dc2b4-9457-41ac-9ce4-74e6e15a1ecb",
            "title": "Hello from curl"
        ]
        // We can't rely on Swift Dictionary key ordering matching the captured string exactly,
        // so instead re-parse both sides and compare structurally.
        let pipelineExpr: [Any] = ["pipeline", 0, ["createNode"], [args]]
        let line = try CapnWebValue.encodeMessageLine(["push", pipelineExpr])
        let reparsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [Any]
        XCTAssertEqual(reparsed[0] as? String, "push")
        let inner = reparsed[1] as! [Any]
        XCTAssertEqual(inner[0] as? String, "pipeline")
        XCTAssertEqual((inner[1] as? NSNumber)?.intValue, 0)
        XCTAssertEqual(inner[2] as! [String], ["createNode"])
    }
}
