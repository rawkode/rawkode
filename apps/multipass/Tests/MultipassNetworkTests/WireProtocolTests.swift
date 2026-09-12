import XCTest
@testable import MultipassNetwork

final class WireProtocolTests: XCTestCase {
    let secret = Data(repeating: 42, count: 32)
    let challenge = Data(repeating: 7, count: 32).base64EncodedString()
    let sender = UUID()

    func testValidClaimAndReplayRejection() throws {
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: secret)
        var verifier = WireProtocol.Verifier(challenge: challenge)
        let claim = verifier.verify(packet, secret: secret)
        XCTAssertEqual(claim?.senderID, sender)
        XCTAssertEqual(claim?.slot, 2)
        XCTAssertNil(verifier.verify(packet, secret: secret))
    }

    func testWrongSecretRejected() throws {
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: Data(repeating: 1, count: 32))
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(packet, secret: secret))
    }

    func testOtherConnectionChallengeRejected() throws {
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: "old-challenge", secret: secret)
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(packet, secret: secret))
    }

    func testInvalidSlotsRejected() throws {
        for slot in [-1, 0, 4, Int.max] {
            let packet = try WireProtocol.sign(senderID: sender, slot: slot, challenge: challenge, secret: secret)
            var verifier = WireProtocol.Verifier(challenge: challenge)
            XCTAssertNil(verifier.verify(packet, secret: secret))
        }
    }

    func testMalformedAndOversizedRejected() {
        for data in [Data(), Data("{}".utf8), Data(repeating: 65, count: 4097)] {
            var verifier = WireProtocol.Verifier(challenge: challenge)
            XCTAssertNil(verifier.verify(data, secret: secret))
        }
    }

    func testTamperedSlotRejected() throws {
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: secret)
        let original = try JSONDecoder().decode(WireProtocol.SignedClaim.self, from: packet)
        let altered = WireProtocol.SignedClaim(claim: .init(version: 1, challenge: challenge, senderID: sender, slot: 1), signature: original.signature)
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(try WireProtocol.encode(altered), secret: secret))
    }

    func testUnsupportedVersionRejected() throws {
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: secret)
        let original = try JSONDecoder().decode(WireProtocol.SignedClaim.self, from: packet)
        let altered = WireProtocol.SignedClaim(claim: .init(version: 2, challenge: challenge, senderID: sender, slot: 2), signature: original.signature)
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(try WireProtocol.encode(altered), secret: secret))
    }

    func testInvalidSecretLengthRejected() throws {
        let shortSecret = Data(repeating: 1, count: 16)
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: shortSecret)
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(packet, secret: shortSecret))
    }

    func testFailedAttemptConsumesChallenge() throws {
        var verifier = WireProtocol.Verifier(challenge: challenge)
        XCTAssertNil(verifier.verify(Data("invalid".utf8), secret: secret))
        let packet = try WireProtocol.sign(senderID: sender, slot: 2, challenge: challenge, secret: secret)
        XCTAssertNil(verifier.verify(packet, secret: secret))
    }
}
