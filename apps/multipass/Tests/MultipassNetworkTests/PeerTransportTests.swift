import XCTest
import Network
@testable import MultipassNetwork

final class PeerTransportTests: XCTestCase {
    @MainActor
    private func waitUntil(_ predicate: () -> Bool, seconds: Double = 3) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return predicate()
    }

    @MainActor
    private func start(_ transport: PeerTransport, secret: Data) async throws -> NWEndpoint {
        transport.start(secret: secret)
        let ready = await waitUntil { transport.listeningPort != nil }
        XCTAssertTrue(ready, "TCP listener must bind")
        let port = try XCTUnwrap(transport.listeningPort)
        return .hostPort(host: .ipv4(.loopback), port: port)
    }

    @MainActor
    func testLoopbackAuthenticatesExactlyOneClaim() async throws {
        let senderID = UUID()
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: senderID, name: "sender")
        defer { sender.stop(); receiver.stop() }
        let secret = Data(repeating: 42, count: 32)
        let endpoint = try await start(receiver, secret: secret)
        _ = try await start(sender, secret: secret)
        var claims: [(UUID, Int)] = []
        receiver.onRequest = { sender, slot, lease in
            XCTAssertTrue(lease.isValid)
            claims.append((sender, slot))
        }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { true })
        let arrived = await waitUntil { claims.count == 1 }
        XCTAssertTrue(arrived)
        let drained = await waitUntil { sender.activeSessionCount == 0 && receiver.activeSessionCount == 0 }
        XCTAssertTrue(drained)
        XCTAssertEqual(claims.count, 1)
        XCTAssertEqual(claims.first?.0, senderID)
        XCTAssertEqual(claims.first?.1, 2)
    }

    @MainActor
    func testLoopbackWrongSecretProducesNoClaim() async throws {
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: UUID(), name: "sender")
        defer { sender.stop(); receiver.stop() }
        let endpoint = try await start(receiver, secret: Data(repeating: 42, count: 32))
        _ = try await start(sender, secret: Data(repeating: 43, count: 32))
        var claims = 0
        receiver.onRequest = { _, _, _ in claims += 1 }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { true })
        XCTAssertEqual(sender.activeSessionCount, 1)
        let drained = await waitUntil { sender.activeSessionCount == 0 && receiver.activeSessionCount == 0 }
        XCTAssertTrue(drained)
        XCTAssertEqual(claims, 0)
    }

    @MainActor
    func testLoopbackInvalidatedAttachmentProducesNoClaim() async throws {
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: UUID(), name: "sender")
        defer { sender.stop(); receiver.stop() }
        let secret = Data(repeating: 42, count: 32)
        let endpoint = try await start(receiver, secret: secret)
        _ = try await start(sender, secret: secret)
        var claims = 0
        var current = true
        receiver.onRequest = { _, _, _ in claims += 1 }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { current })
        XCTAssertEqual(sender.activeSessionCount, 1)
        current = false
        let drained = await waitUntil { sender.activeSessionCount == 0 && receiver.activeSessionCount == 0 }
        XCTAssertTrue(drained)
        XCTAssertEqual(claims, 0)
    }

    @MainActor
    func testStopCancelsPendingSessionAndFencesCallback() async throws {
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: UUID(), name: "sender")
        defer { sender.stop(); receiver.stop() }
        let secret = Data(repeating: 42, count: 32)
        let endpoint = try await start(receiver, secret: secret)
        _ = try await start(sender, secret: secret)
        var claims = 0
        receiver.onRequest = { _, _, _ in claims += 1 }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { true })
        XCTAssertEqual(sender.activeSessionCount, 1)
        sender.stop()
        XCTAssertEqual(sender.activeSessionCount, 0)
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(claims, 0)
    }
    @MainActor
    func testDestinationDepartureRevokesDeliveredLease() async throws {
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: UUID(), name: "sender")
        defer { sender.stop(); receiver.stop() }
        let secret = Data(repeating: 42, count: 32)
        let endpoint = try await start(receiver, secret: secret)
        _ = try await start(sender, secret: secret)
        var current = true
        var lease: RequestLease?
        receiver.onRequest = { _, _, received in lease = received }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { current })
        let arrived = await waitUntil { lease != nil }
        XCTAssertTrue(arrived)
        XCTAssertTrue(try XCTUnwrap(lease).isValid)
        current = false
        let revoked = await waitUntil({ lease?.isValid == false }, seconds: 0.5)
        XCTAssertTrue(revoked, "Departure must revoke before the one-second lease expiry")
    }

    @MainActor
    func testReceiverStopRevokesDeliveredLease() async throws {
        let receiver = PeerTransport(nodeID: UUID(), name: "receiver")
        let sender = PeerTransport(nodeID: UUID(), name: "sender")
        defer { sender.stop(); receiver.stop() }
        let secret = Data(repeating: 42, count: 32)
        let endpoint = try await start(receiver, secret: secret)
        _ = try await start(sender, secret: secret)
        var lease: RequestLease?
        receiver.onRequest = { _, _, received in lease = received }
        sender.announceAttachment(slot: 2, to: [endpoint], isStillCurrent: { true })
        let arrived = await waitUntil { lease != nil }
        XCTAssertTrue(arrived)
        receiver.stop()
        XCTAssertFalse(try XCTUnwrap(lease).isValid)
    }

    @MainActor
    func testBonjourDiscoversOtherInstanceAndExcludesSelf() async throws {
        let firstID = UUID()
        let secondID = UUID()
        let first = PeerTransport(nodeID: firstID, name: "first")
        let second = PeerTransport(nodeID: secondID, name: "second")
        defer { first.stop(); second.stop() }
        var firstPeers: [String] = []
        var secondPeers: [String] = []
        first.onPeers = { firstPeers = $0 }
        second.onPeers = { secondPeers = $0 }
        let secret = Data(repeating: 42, count: 32)
        _ = try await start(first, secret: secret)
        _ = try await start(second, secret: secret)
        let discovered = await waitUntil({
            firstPeers.contains(secondID.uuidString) && secondPeers.contains(firstID.uuidString)
        }, seconds: 10)
        XCTAssertTrue(discovered, "Bonjour must discover both independently advertised service UUIDs")
        XCTAssertFalse(firstPeers.contains(firstID.uuidString))
        XCTAssertFalse(secondPeers.contains(secondID.uuidString))
    }

}
