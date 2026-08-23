import Foundation
import XCTest

/// Loads a fixture JSON file produced by `scripts/generate-fixtures.ts` (real
/// `@athenaeum/domain` `Schema.encodeSync` output, see that script's header comment for the one
/// documented exception — the three binary-field RPC fixtures). Fails the test loudly (not an
/// optional/silent skip) if the fixture is missing, since a missing fixture means the test suite
/// and the fixture generator have drifted, which is exactly the kind of drift this package's
/// tests exist to catch.
func loadFixture(_ name: String, file: StaticString = #filePath, line: UInt = #line) -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
        XCTFail("Missing fixture Fixtures/\(name).json — run scripts/generate-fixtures.ts", file: file, line: line)
        return Data()
    }
    do {
        return try Data(contentsOf: url)
    } catch {
        XCTFail("Failed to read fixture \(name).json: \(error)", file: file, line: line)
        return Data()
    }
}

func decodeFixture<T: Decodable>(
    _ type: T.Type,
    _ name: String,
    file: StaticString = #filePath,
    line: UInt = #line
) throws -> T {
    let data = loadFixture(name, file: file, line: line)
    return try JSONDecoder().decode(T.self, from: data)
}

/// Round-trips `value` through `JSONEncoder`/`JSONDecoder` and asserts the result is equal to the
/// original — catches an asymmetric encode/decode implementation (a real risk for the hand-written
/// tagged-union `Codable` conformances in `ViewSpec.swift`).
func assertRoundTrips<T: Codable & Equatable>(
    _ value: T,
    file: StaticString = #filePath,
    line: UInt = #line
) throws {
    let data = try JSONEncoder().encode(value)
    let decoded = try JSONDecoder().decode(T.self, from: data)
    XCTAssertEqual(decoded, value, "round-trip mismatch", file: file, line: line)
}
