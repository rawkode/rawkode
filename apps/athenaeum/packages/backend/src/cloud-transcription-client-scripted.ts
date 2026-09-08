// `CloudTranscriptionClientScripted` — the deterministic test double half of the plan's "two real
// Layer implementations" for `CloudTranscriptionClient` (plan §"Meetings & voice", mirroring
// `model-client-scripted.ts`'s own design exactly, field-for-field: a factory a test calls once
// per test case, closing over a fresh, test-owned queue and call log — same "not a module-level
// mutable queue" caution `model-client-scripted.ts`'s own header comment documents).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  CloudTranscriptionClient,
  type TranscribeAudioInput,
  type TranscribeAudioOutput,
  TranscriptionUnavailable
} from "@athenaeum/domain"

export interface ScriptedTranscribeCall {
  readonly input: TranscribeAudioInput
}

export interface CloudTranscriptionClientScriptedHandle {
  readonly layer: Layer.Layer<CloudTranscriptionClient>
  readonly calls: Array<ScriptedTranscribeCall>
  readonly remaining: () => number
}

/**
 * Builds a fresh scripted handle from a fixed, ordered sequence of `TranscribeAudioOutput`s. Each
 * `transcribe` call shifts the next entry off the front and returns it; calling `transcribe` more
 * times than the script has entries fails with `TranscriptionUnavailable` — same "exhausted script
 * is a test-configuration bug, but still correctly modeled as 'this client cannot answer right
 * now'" reasoning as `makeModelClientScripted`'s own doc comment.
 */
export const makeCloudTranscriptionClientScripted = (
  script: ReadonlyArray<TranscribeAudioOutput>
): CloudTranscriptionClientScriptedHandle => {
  const queue: Array<TranscribeAudioOutput> = [...script]
  const calls: Array<ScriptedTranscribeCall> = []

  const layer = Layer.succeed(CloudTranscriptionClient, {
    transcribe: (input) =>
      Effect.sync(() => {
        calls.push({ input })
        return queue.shift()
      }).pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.fail(
                new TranscriptionUnavailable({
                  message:
                    `CloudTranscriptionClientScripted: script exhausted after ${calls.length} transcribe() call(s) — ` +
                    "pre-program more outputs via makeCloudTranscriptionClientScripted(script) if the test needs another."
                })
              )
            : Effect.succeed(next)
        )
      )
  })

  return { layer, calls, remaining: () => queue.length }
}
