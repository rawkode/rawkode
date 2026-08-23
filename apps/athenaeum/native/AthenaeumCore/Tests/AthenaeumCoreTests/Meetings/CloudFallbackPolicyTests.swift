import XCTest
@testable import AthenaeumCore

final class CloudFallbackPolicyTests: XCTestCase {
    func testHighConfidenceNonEmptyResultDoesNotFallBack() {
        let result: Result<TranscriptionResult, OnDeviceTranscriptionError> =
            .success(TranscriptionResult(text: "create a note about the roadmap", confidence: 0.92))
        XCTAssertFalse(CloudFallbackPolicy.shouldFallBackToCloud(result: result))
    }

    func testLowConfidenceFallsBack() {
        let result: Result<TranscriptionResult, OnDeviceTranscriptionError> =
            .success(TranscriptionResult(text: "mumble mumble", confidence: 0.2))
        XCTAssertTrue(CloudFallbackPolicy.shouldFallBackToCloud(result: result))
    }

    func testEmptyTranscriptFallsBackEvenAtHighConfidence() {
        let result: Result<TranscriptionResult, OnDeviceTranscriptionError> =
            .success(TranscriptionResult(text: "   ", confidence: 0.99))
        XCTAssertTrue(CloudFallbackPolicy.shouldFallBackToCloud(result: result))
    }

    func testAnyErrorFallsBack() {
        let result: Result<TranscriptionResult, OnDeviceTranscriptionError> = .failure(.notAuthorized)
        XCTAssertTrue(CloudFallbackPolicy.shouldFallBackToCloud(result: result))
    }

    func testExactlyAtThresholdDoesNotFallBack() {
        let result: Result<TranscriptionResult, OnDeviceTranscriptionError> =
            .success(TranscriptionResult(text: "ok", confidence: CloudFallbackPolicy.minimumAcceptableConfidence))
        XCTAssertFalse(CloudFallbackPolicy.shouldFallBackToCloud(result: result))
    }
}
