import XCTest
@testable import AthenaeumCore

/// Pure, deterministic tests for `pcm16Data(from:)` — no capture source, no RPC, exact byte-level
/// assertions against known Float inputs.
final class PCM16Tests: XCTestCase {
    func testEmptyInputProducesEmptyData() {
        XCTAssertEqual(pcm16Data(from: []), Data())
    }

    func testSilenceProducesAllZeroBytes() {
        let data = pcm16Data(from: [0, 0, 0])
        XCTAssertEqual(data, Data([0, 0, 0, 0, 0, 0]))
    }

    func testKnownValuesEncodeToExpectedLittleEndianInt16() {
        // 0.5 -> round(0.5 * 32767) = 16384 = 0x4000 -> LE bytes [0x00, 0x40]
        // -0.5 -> round(-0.5 * 32768) = -16384 = 0xC000 -> LE bytes [0x00, 0xC0]
        let data = pcm16Data(from: [0.5, -0.5])
        XCTAssertEqual(Array(data), [0x00, 0x40, 0x00, 0xC0])
    }

    func testFullScalePositiveAndNegativeClampToInt16Extremes() {
        let data = pcm16Data(from: [1.0, -1.0])
        let samples = pcm16Samples(from: data)
        XCTAssertEqual(samples, [32767, -32768])
    }

    func testOutOfRangeInputIsClampedNotWrapped() {
        // A real capture source should never produce samples outside [-1, 1], but a defensive
        // encoder shouldn't wrap/overflow if it somehow did (e.g. a summed-and-not-renormalized
        // multi-channel downmix rounding error).
        let data = pcm16Data(from: [2.0, -2.0])
        let samples = pcm16Samples(from: data)
        XCTAssertEqual(samples, [32767, -32768])
    }

    func testOutputByteCountIsExactlyTwicePerSample() {
        let data = pcm16Data(from: Array(repeating: Float(0.1), count: 100))
        XCTAssertEqual(data.count, 200)
    }

    /// Decodes little-endian Int16 samples back out of PCM16 `Data` — the inverse this test file
    /// needs for exact round-trip assertions; not part of the production API (native voice sends
    /// PCM16 bytes one-way, to the backend, so nothing in the app needs a decoder).
    private func pcm16Samples(from data: Data) -> [Int16] {
        var result: [Int16] = []
        var index = data.startIndex
        while index < data.endIndex {
            let low = UInt16(data[index])
            let high = UInt16(data[data.index(after: index)])
            result.append(Int16(bitPattern: low | (high << 8)))
            index = data.index(index, offsetBy: 2)
        }
        return result
    }
}
