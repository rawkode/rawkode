// `CloudTranscriptionClientOpenAI` — a real HTTP client against OpenAI's actual
// `POST /v1/audio/transcriptions` endpoint. Request/response shape verified this stage against
// OpenAI's own current API reference (WebFetch — see below for exactly what was confirmed), same
// "real, correctly-shaped, genuinely unreachable without configuration" discipline as
// `model-client-anthropic.ts` and `google-calendar-client-real.ts`.
//
// **No real cloud-transcription API key exists in this environment** (hard constraint) —
// `makeCloudTranscriptionClientOpenAILive({apiKey: undefined})` fails every `transcribe` call with
// `TranscriptionUnavailable` before attempting any network I/O, and is never exercised end-to-end
// against the real API here. It IS exercised against a mocked `HttpFetch` layer
// (`test/cloud-transcription-client-openai.test.ts`) to prove the request-building/response-
// parsing logic independently of network access, reusing the SAME `HttpFetch` Context.Tag
// `model-client-anthropic.ts` already establishes (one fetch-shaped seam for this package, not a
// duplicate per client) — **a real live-API integration test is explicitly not possible in this
// environment.**
//
// **Model choice: `whisper-1`, not `gpt-4o-transcribe`.** Both are valid current OpenAI
// transcription models (confirmed via WebFetch against OpenAI's own current API reference this
// stage), but only `whisper-1`'s `response_format: "verbose_json"` has a long-stable, thoroughly
// documented `segments[]` shape (`{text, start, end, ...}`) — exactly what this domain's
// `TranscriptSegment` needs for meeting-transcript timestamps. `gpt-4o-transcribe`'s newer
// `diarized_json` format was confirmed to exist by the same WebFetch pass but its exact segment
// shape was not independently confirmed field-by-field this stage — picking the model whose wire
// shape is fully verified, rather than guessing at the newer one's, is the same "don't guess"
// discipline `google-calendar-client-real.ts`'s header comment describes. `model` is still a
// config override, so swapping to `gpt-4o-transcribe` later is a one-line change once its
// `diarized_json` shape is independently verified.
//
// What David would need to make this real: an OpenAI API key with access to the Audio API
// (platform.openai.com → API keys), passed as `OPENAI_TRANSCRIPTION_API_KEY` — deliberately a
// SEPARATE secret name from any future `OPENAI_API_KEY` a different provider integration might
// use, so the two can be scoped/rotated independently — via `wrangler secret put
// OPENAI_TRANSCRIPTION_API_KEY` on the real deployment (never plaintext `vars`).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  CloudTranscriptionClient,
  TranscribeAudioOutput,
  TranscriptionRequestFailed,
  TranscriptionResponseInvalid,
  TranscriptionUnavailable,
  TranscriptSegment
} from "@athenaeum/domain"
import { HttpFetch } from "./model-client-anthropic.js"
import { type AiGatewayRoute, gatewayAuthHeader, gatewayHttpUrl } from "./ai-gateway-route.js"

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions"
const DEFAULT_MODEL = "whisper-1"

export interface CloudTranscriptionClientOpenAIConfig {
  /** The real secret, read by the caller from wherever it lives (a Worker secret binding) —
   *  `undefined` in every environment that hasn't configured one, including this one. */
  readonly apiKey: string | undefined
  readonly model?: string
  /** `undefined` (the default) => DIRECT mode, calling `api.openai.com` exactly as before this
   *  config field existed. When set, requests route through Cloudflare AI Gateway's per-provider
   *  passthrough endpoint instead — same `ai-gateway-route.ts` mechanism as
   *  `model-client-anthropic.ts`'s identical `gateway` field. Note (docs/ai-gateway-decisions.md
   *  §1): `/audio/transcriptions` follows Cloudflare's documented prefix-substitution rule but has
   *  no worked example on Cloudflare's OpenAI provider page — inferred from the rule, not
   *  independently confirmed against a live gateway. */
  readonly gateway?: AiGatewayRoute
}

// --- Response parsing ----------------------------------------------------------------------
//
// https://platform.openai.com/docs/api-reference/audio/createTranscription (verified this stage):
// `verbose_json` response is `{text, language?, duration?, segments?: [{id, seek, start, end,
// text, tokens, temperature, avg_logprob, compression_ratio, no_speech_prob}], words?}`. Only the
// fields this domain's `TranscriptSegment`/`TranscribeAudioOutput` actually use are decoded —
// same "deliberately loose, not an exhaustive Schema.Union over every provider field" discipline
// as `model-client-anthropic.ts`'s own `AnthropicResponseEnvelope` doc comment; `Schema.Struct`
// (not `Schema.extend`/strict) already ignores unrecognized keys like `tokens`/`avg_logprob`
// rather than failing decode on their presence.

const OpenAiTranscriptionSegment = Schema.Struct({
  text: Schema.String,
  start: Schema.Number,
  end: Schema.Number
})

const OpenAiTranscriptionResponse = Schema.Struct({
  text: Schema.String,
  language: Schema.optional(Schema.String),
  segments: Schema.optional(Schema.Array(OpenAiTranscriptionSegment))
})

const parseResponseBody = (
  body: unknown
): Effect.Effect<TranscribeAudioOutput, TranscriptionResponseInvalid> =>
  Schema.decodeUnknown(OpenAiTranscriptionResponse)(body).pipe(
    Effect.mapError(
      (parseError) =>
        new TranscriptionResponseInvalid({
          message: `OpenAI transcription response did not match the expected shape: ${parseError.message}`
        })
    ),
    Effect.map(
      (parsed) =>
        new TranscribeAudioOutput({
          text: parsed.text,
          segments: (parsed.segments ?? []).map(
            (segment) =>
              new TranscriptSegment({ text: segment.text, startSeconds: segment.start, endSeconds: segment.end })
          ),
          ...(parsed.language === undefined ? {} : { languageDetected: parsed.language })
        })
    )
  )

// --- The Layer -----------------------------------------------------------------------------

export const makeCloudTranscriptionClientOpenAILive = (
  config: CloudTranscriptionClientOpenAIConfig
): Layer.Layer<CloudTranscriptionClient, never, HttpFetch> =>
  Layer.effect(
    CloudTranscriptionClient,
    Effect.gen(function* () {
      const http = yield* HttpFetch
      const model = config.model ?? DEFAULT_MODEL
      // GATEWAY mode: see model-client-anthropic.ts's identical comment on requestUrl — a pure
      // URL-prefix swap, the multipart request/response shape below is unchanged either way.
      const requestUrl = config.gateway === undefined
        ? OPENAI_TRANSCRIPTIONS_URL
        : gatewayHttpUrl(config.gateway, "openai/audio/transcriptions")

      return {
        transcribe: (input) =>
          Effect.gen(function* () {
            // Hard constraint: cleanly no-op/erroring when unconfigured — never attempts network
            // I/O without a real key. Checked on every call, not memoized at Layer-build time —
            // same "a key that becomes available later is picked up without rebuilding the Layer"
            // reasoning as `model-client-anthropic.ts`.
            const apiKey = config.apiKey
            if (apiKey === undefined || apiKey.length === 0) {
              return yield* Effect.fail(
                new TranscriptionUnavailable({
                  message: "CloudTranscriptionClientOpenAI: no API key configured (OPENAI_TRANSCRIPTION_API_KEY unset)"
                })
              )
            }

            // Multipart/form-data — OpenAI's endpoint requires the audio as a real file part
            // (with a filename it sniffs the format from), not a JSON body. `FormData`/`Blob` are
            // both real Web-standard APIs available in `workerd` (and Node's `undici`-backed
            // `fetch`), no extra dependency needed — same "no @effect/platform for one call"
            // reasoning `model-client-anthropic.ts`'s `HttpFetch` doc comment gives for skipping a
            // heavier HTTP client library here too.
            const form = new FormData()
            form.append("file", new Blob([input.audio], { type: input.mimeType }), input.filename)
            form.append("model", model)
            form.append("response_format", "verbose_json")
            if (input.languageHint !== undefined) form.append("language", input.languageHint)

            const response = yield* Effect.tryPromise({
              try: () =>
                http.fetch(requestUrl, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${apiKey}`, ...gatewayAuthHeader(config.gateway) },
                  body: form
                }),
              catch: (cause) =>
                new TranscriptionRequestFailed({
                  message: `request to OpenAI's transcription API failed: ${cause instanceof Error ? cause.message : String(cause)}`
                })
            })

            if (!response.ok) {
              const bodyText = yield* Effect.tryPromise({
                try: () => response.text(),
                catch: () => new TranscriptionRequestFailed({ message: "failed to read error response body", status: response.status })
              }).pipe(Effect.catchAll(() => Effect.succeed("<unreadable body>")))
              return yield* Effect.fail(
                new TranscriptionRequestFailed({
                  message: `OpenAI transcription API returned ${response.status}: ${bodyText}`,
                  status: response.status
                })
              )
            }

            const json = yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) =>
                new TranscriptionResponseInvalid({
                  message: `OpenAI transcription response body was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
                })
            })

            return yield* parseResponseBody(json)
          })
      }
    })
  )
