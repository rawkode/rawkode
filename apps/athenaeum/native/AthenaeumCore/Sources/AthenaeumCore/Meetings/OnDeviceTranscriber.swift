import Foundation

/// Real dependency-injection seam for on-device ASR — same "protocol first, real+test
/// implementations behind it" discipline as `AudioCaptureSource`. `SFSpeechRecognizerTranscriber`
/// (real, wraps `SFSpeechRecognizer`) is the production implementation; a test provides its own
/// `Layer`-equivalent stub where needed rather than this file growing a built-in fake, since
/// unlike audio *capture* (which genuinely cannot be exercised live here — see
/// `AudioCaptureSource`'s doc comment), on-device ASR's real implementation WAS attempted live
/// this stage — see `SFSpeechRecognizerTranscriber`'s own header comment for the exact outcome.
public struct TranscriptionResult: Sendable, Equatable {
    public let text: String
    public let confidence: Float
    public init(text: String, confidence: Float) {
        self.text = text
        self.confidence = confidence
    }
}

public enum OnDeviceTranscriptionError: Error, Sendable, Equatable {
    case notAuthorized
    case recognizerUnavailable
    case requestFailed(String)
}

public protocol OnDeviceTranscriber: Sendable {
    func transcribe(_ chunk: AudioChunk) async throws -> TranscriptionResult
}

/// Real fallback-decision policy (plan hard constraint's "on-device ASR + cloud fallback"): pure,
/// synchronous, real logic — not a stub — deciding whether a chunk's on-device result is good
/// enough to keep, or whether the caller should retry via `CloudTranscriptionClient` (the
/// backend-side Effect service in `packages/domain/src/cloud-transcription.ts`). Kept as a free
/// function (not baked into `OnDeviceTranscriber` itself) so it's independently unit-testable
/// against hand-constructed results/errors without any ASR engine involved at all.
public enum CloudFallbackPolicy {
    /// Below this confidence, or on any `OnDeviceTranscriptionError`/empty transcript, a chunk is
    /// considered a fallback candidate. `0.5` is a deliberately conservative (favor cloud
    /// fallback) starting point for a spike — real tuning needs production confidence-score
    /// distributions this stage has no data for.
    public static let minimumAcceptableConfidence: Float = 0.5

    public static func shouldFallBackToCloud(result: Result<TranscriptionResult, OnDeviceTranscriptionError>) -> Bool {
        switch result {
        case .failure:
            return true
        case .success(let value):
            return value.confidence < minimumAcceptableConfidence || value.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}
