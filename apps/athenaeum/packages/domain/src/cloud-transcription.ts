import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// Phase 6 spike (plan §"Meetings & voice", task item 2: "Design pluggable CloudTranscriptionClient
// ... Effect Context.Tags (backend-side) mirroring the ModelClient/GoogleCalendarClient pattern
// exactly"). This file owns only the *interface* — entity/wire schemas, the closed
// `TranscriptionError` failure channel, and the `CloudTranscriptionClient` Context.Tag — zero
// Cloudflare/`fetch`/env-binding dependencies, exactly like `model-client.ts`'s own doc comment
// describes for `ModelClient`. Two real `Layer` implementations live in `packages/backend`:
// `CloudTranscriptionClientScripted` (deterministic test double) and
// `CloudTranscriptionClientOpenAI` (a real HTTP client against OpenAI's
// `POST /v1/audio/transcriptions` — see that file's own header comment for exactly which
// request/response shape was verified, and against which model). Full design rationale, including
// why this exists as a *fallback* behind on-device ASR rather than the primary path:
// docs/meetings-voice-decisions.md §2.

/** One segment of a transcription result — start/end offsets (seconds, relative to the audio
 *  chunk sent, not wall-clock) plus the text spoken in that window. Deliberately narrower than
 *  a provider's full segment shape (Whisper's `verbose_json` segments also carry `id`, `seek`,
 *  `tokens`, `temperature`, `avg_logprob`, `compression_ratio`, `no_speech_prob` — see
 *  `cloud-transcription-client-openai.ts`'s own doc comment for why only `text`/`start`/`end`
 *  survive into this domain type): those extra fields are provider-internal decoding diagnostics,
 *  not anything a caller of this domain-level interface (`MeetingsService`, eventually) has a use
 *  for — same "structural rename, not a lossy translation for anything that matters" discipline as
 *  `ChatContentBlock`'s own doc comment in `model-client.ts`. */
export class TranscriptSegment extends Schema.Class<TranscriptSegment>("TranscriptSegment")({
  text: Schema.String,
  startSeconds: Schema.Number,
  endSeconds: Schema.Number
}) {}

/** One audio chunk to transcribe. `audio` is raw encoded bytes (not base64 — base64 is a wire
 *  concern the real HTTP client's multipart body construction handles, not something this
 *  interface should force every caller, including `CloudTranscriptionClientScripted`, to encode
 *  for no reason). `filename` matters even though nothing reads the file off disk: OpenAI's
 *  (and every other provider's) multipart transcription endpoint sniffs audio format from the
 *  filename's extension, so a caller must supply one that matches `mimeType` (e.g.
 *  `"chunk-0001.wav"` + `"audio/wav"`) or the real API rejects the request — this is not a
 *  cosmetic field. */
export class TranscribeAudioInput extends Schema.Class<TranscribeAudioInput>("TranscribeAudioInput")({
  audio: Schema.Uint8ArrayFromSelf,
  mimeType: Schema.String,
  filename: Schema.String,
  languageHint: Schema.optional(Schema.String)
}) {}

export class TranscribeAudioOutput extends Schema.Class<TranscribeAudioOutput>("TranscribeAudioOutput")({
  text: Schema.String,
  segments: Schema.Array(TranscriptSegment),
  languageDetected: Schema.optional(Schema.String)
}) {}

// --- TranscriptionError: the closed failure channel, same 3-variant shape as ModelError --------
//
// Deliberately mirrors `model-client.ts`'s `ModelError` variant-for-variant (see that file's own
// doc comment for the reasoning each variant name is chosen for) — a provider-agnostic
// transcription call fails in exactly the same three places a provider-agnostic chat call does:
// "cannot answer at all" / "the network call itself failed" / "a response came back but doesn't
// parse." Not unified into one shared type across both files because `ModelClient` and
// `CloudTranscriptionClient` are independent Context.Tags with independent call sites
// (`AgentEditService` vs. a future `MeetingsService`) — a shared error type would couple two
// unrelated services' failure channels for no benefit, the same reasoning
// `GoogleCalendarClientError` already applies as its own independent closed union.

export class TranscriptionUnavailable extends Data.TaggedError("TranscriptionUnavailable")<{
  readonly message: string
}> {}

export class TranscriptionRequestFailed extends Data.TaggedError("TranscriptionRequestFailed")<{
  readonly message: string
  readonly status?: number
}> {}

export class TranscriptionResponseInvalid extends Data.TaggedError("TranscriptionResponseInvalid")<{
  readonly message: string
}> {}

export type TranscriptionError = TranscriptionUnavailable | TranscriptionRequestFailed | TranscriptionResponseInvalid

/**
 * The pluggable cloud-transcription-fallback service. "Fallback" is load-bearing (plan hard
 * constraint: on-device ASR is the primary path — see `docs/meetings-voice-decisions.md` §1 for
 * the native on-device pipeline this backs up): a caller reaches for this only when on-device
 * `SFSpeechRecognizer` is unavailable/unauthorized/low-confidence on a given chunk, uploading that
 * one chunk's audio rather than a whole meeting's — the same "narrow the blast radius of the
 * network dependency" discipline `ModelClientAnthropic`'s per-turn (not per-session) calls follow.
 */
export class CloudTranscriptionClient extends Context.Tag("@athenaeum/domain/CloudTranscriptionClient")<
  CloudTranscriptionClient,
  {
    readonly transcribe: (input: TranscribeAudioInput) => Effect.Effect<TranscribeAudioOutput, TranscriptionError>
  }
>() {}
