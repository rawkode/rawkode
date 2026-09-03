import XCTest
@testable import AthenaeumAppUI
@testable import AthenaeumRPC

@MainActor
final class DailyNoteInlineSupertagPickerTests: XCTestCase {
    func testSearchPreservesAuthoritativeOrderAndFiltersCaseInsensitively() async throws {
        let model = DailyNoteInlineSupertagSearchModel(client: StubCatalogClient(tags: [
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61", name: "Beta", builtin: false),
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62", name: "alpha", builtin: false),
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e63", name: "Gamma", builtin: false),
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e64", name: "Project", builtin: false)
        ]))

        model.search(query: "A")
        try await waitUntilSettled(model)

        XCTAssertEqual(model.candidates.map(\.title), ["Beta", "alpha", "Gamma"])
        XCTAssertNil(model.errorMessage)
    }

    func testNewQueryCancelsOlderCatalogCompletion() async throws {
        let model = DailyNoteInlineSupertagSearchModel(client: StubCatalogClient(tags: [
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e61", name: "Alpha", builtin: false),
            RPCTag(id: "01912f8a-7b3e-7c3e-8b3e-0a1b2c3d4e62", name: "Gamma", builtin: false)
        ]))

        model.search(query: "a")
        model.search(query: "g")
        try await waitUntilSettled(model)

        XCTAssertEqual(model.candidates.map(\.title), ["Gamma"])
        XCTAssertNil(model.errorMessage)
    }

    private func waitUntilSettled(_ model: DailyNoteInlineSupertagSearchModel) async throws {
        for _ in 0..<40 {
            if !model.isSearching { return }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTFail("Supertag search did not settle")
    }
}

private struct StubCatalogClient: DailyNoteInlineSupertagCatalogClient {
    let tags: [RPCTag]

    func listTags() async throws -> [RPCTag] { tags }
}
