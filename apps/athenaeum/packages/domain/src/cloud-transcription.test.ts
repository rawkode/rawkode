import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  TranscribeAudioInput,
  TranscribeAudioOutput,
  TranscriptionRequestFailed,
  TranscriptionResponseInvalid,
  TranscriptionUnavailable,
  TranscriptSegment
} from "./cloud-transcription.js"

describe("TranscribeAudioInput schema", () => {
  it("round-trips raw audio bytes, mimeType, filename, and an optional languageHint", () => {
    const input = new TranscribeAudioInput({
      audio: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/wav",
      filename: "chunk-0001.wav",
      languageHint: "en"
    })
    const encoded = Schema.encodeSync(TranscribeAudioInput)(input)
    expect(Schema.decodeUnknownSync(TranscribeAudioInput)(encoded)).toEqual(input)
  })

  it("languageHint is optional", () => {
    const input = new TranscribeAudioInput({
      audio: new Uint8Array([9]),
      mimeType: "audio/wav",
      filename: "chunk.wav"
    })
    const encoded = Schema.encodeSync(TranscribeAudioInput)(input)
    expect(encoded.languageHint).toBeUndefined()
  })
})

describe("TranscribeAudioOutput / TranscriptSegment schemas", () => {
  it("round-trips text plus segments", () => {
    const output = new TranscribeAudioOutput({
      text: "the quick brown fox",
      segments: [
        new TranscriptSegment({ text: "the quick brown fox", startSeconds: 0, endSeconds: 2.5 })
      ],
      languageDetected: "en"
    })
    const encoded = Schema.encodeSync(TranscribeAudioOutput)(output)
    expect(Schema.decodeUnknownSync(TranscribeAudioOutput)(encoded)).toEqual(output)
  })

  it("segments may be empty (a provider that returns text only)", () => {
    const output = new TranscribeAudioOutput({ text: "hi", segments: [] })
    const encoded = Schema.encodeSync(TranscribeAudioOutput)(output)
    expect(Schema.decodeUnknownSync(TranscribeAudioOutput)(encoded)).toEqual(output)
  })

  it("rejects a segment missing required numeric fields", () => {
    const result = Schema.decodeUnknownEither(TranscriptSegment)({ text: "x", startSeconds: 0 })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("TranscriptionError variants", () => {
  it("are Data.TaggedError instances with the expected _tag", () => {
    expect(new TranscriptionUnavailable({ message: "no API key" })._tag).toBe("TranscriptionUnavailable")
    expect(new TranscriptionRequestFailed({ message: "network error", status: 500 })._tag)
      .toBe("TranscriptionRequestFailed")
    expect(new TranscriptionResponseInvalid({ message: "bad json" })._tag).toBe("TranscriptionResponseInvalid")
  })
})
