// AssistantSceneAssembly.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave, track 4 — "Assistant reachability"). The
// ONE place `AssistantConversationController` (P5, `AssistantConversationController
// .swift`) is actually constructed for a real, running app screen — closing
// the exact gap the plan's P7 section calls out by name: "the assistant —
// despite being fully built and tested in P5 — is not reachable from any
// screen in the running app," and P5's own "Tracked, not fixed" note:
// "`AssistantConversationController`/`AssistantConversationView` have no
// real call site wired into an actual app screen yet."
//
// This file is composition only — it constructs real values and passes
// them to `AssistantConversationController`'s PUBLIC init exactly as
// documented; it does not modify that controller, `AssistantLocalToolDispatcher`,
// or any other P5 file.
//
// ============================================================================
// UPDATE (task #96, plan §Live Backend Connectivity (P8) scope item 3):
// THE REMOTE-TOOL AUTHORIZATION P7 DELIBERATELY LEFT OFF IS NOW RE-ENABLED
// ============================================================================
//
// P7's original header (preserved in spirit below) left `emailClient`/
// `remoteWriteClient`/`remoteWriteReviewClient` all `nil` for two
// independently-confirmed reasons: (1) vault had no HTTP proxy route to
// `gatekeeper-google`'s write RPCs, and (2) no device-enrollment mechanism
// existed to mint a real Cloudflare Access credential even if it did. Task
// #94 fixed (1); task #95 fixed (2). Both conditions this file's own
// comments cited as the reason to leave these off are now resolved AT THE
// CODE LEVEL — so this pass wires all three for real, through
// `EnchiridionCore.DeviceAccessCredentialResolver` (reads task #95's real
// Keychain-backed `DeviceAccessCredentialStore`).
//
// WHAT "RE-ENABLED" DOES AND DOES NOT MEAN — read before assuming more than
// this claims:
//   - The MODEL is now offered `searchEmailThreads` and every remote write
//     tool (`proposeCreateEvent`/`proposeRsvp`/`proposeSendEmail`/the 5
//     Gmail triage tools) when a turn's authorization allows it
//     (`AssistantConversationAuthorizationFactory`, this module) — real
//     `AssistantRemoteWriteClient`/`VaultEmailSearchClient` values are
//     constructed and handed to the dispatcher, not `nil`.
//   - On a device with NO enrolled credential (every device in this
//     sandbox, since no real deployment/enrollment exists here — see
//     `AppBackendConfiguration.swift`'s header), calling any of these
//     tools throws `DeviceAccessCredentialResolutionError.deviceNotEnrolled`
//     from the credential-resolution closure BEFORE any request is even
//     built. `OpenAIResponsesAssistant.performAttempt`'s existing generic
//     `catch` turns that into `.grounded(failureResponse(.invalidResponse))`
//     — the SAME graceful, non-crashing turn-failure path every other
//     tool-execution error already goes through (see that file). This is
//     the honest "structurally can't succeed yet, but fails cleanly, not
//     silently or by crashing" property task #96's brief asks for.
//   - `taskSnapshotProvider` stays `nil` — out of THIS task's scope (see
//     the unchanged note below); `proposeTaskUpdate`/`proposeTaskComplete`
//     remain unauthorized.
//   - The SAFETY PROPERTIES this re-enablement must not disturb —
//     eligibility checking (`eligibleCalendarSourceIDs`/
//     `eligibleTaskPageIDs`/`eligibleEmailThreadIDs`, all still enforced
//     one layer down in `AssistantLocalToolDispatcher.swift`, unmodified
//     by this file) and the propose-only/never-confirm type split
//     (`remoteWriteClient` below is an `AssistantRemoteWriteClient` — ONLY
//     `AssistantRemoteWriteTransport`-conforming, handed to the
//     dispatcher; `remoteWriteReviewClient` below is a STRUCTURALLY
//     UNRELATED `AssistantRemoteWriteReviewClient`, retained only by the
//     controller's own `confirmProposal(_:)`, reached only from an
//     explicit human tap — see `AssistantConversationController.swift`'s
//     header) — are unchanged by this file. This file only supplies real
//     credentials to constructors that already existed; it does not touch
//     the type-level split that makes self-confirm structurally
//     unreachable. See `AssistantRemoteWriteToolsTests.swift`'s
//     `testProposeOnlyClientCannotBeTreatedAsAReviewClient` and
//     `AssistantLocalToolDispatcherTests.swift`'s
//     `testWriteFacadesCannotBeSwappedForReviewerShapedValues` for the
//     re-verified proof.
import EnchiridionAPI
import EnchiridionCore
import EnchiridionStore
import Foundation

public enum AssistantSceneAssemblyError: Error, LocalizedError, Sendable {
  case noAPIKeyConfigured

  public var errorDescription: String? {
    switch self {
    case .noAPIKeyConfigured:
      "No OpenAI API key is configured on this device yet."
    }
  }
}

public enum AssistantSceneAssembly {
  /// See this file's header — a real OpenAI Responses API model
  /// identifier, not a placeholder string, but the specific choice hasn't
  /// been validated against a live account from this sandbox (no network
  /// egress here — matches P5's own already-documented "unverified against
  /// a live API call" caveat). A future settings surface should make this
  /// configurable rather than hardcoding it more permanently.
  public static let defaultModelID = "gpt-4.1-mini"

  /// Builds a real `AssistantConversationController` over `store` — see
  /// this file's header for exactly what is/isn't live behind it.
  ///
  /// - Parameter deviceCredentialStore: THIS device's own Keychain-backed
  ///   Access service-token store (task #95) — every remote client this
  ///   function constructs (`emailClient`/`remoteWriteClient`/
  ///   `remoteWriteReviewClient`) resolves its credential through it, fresh
  ///   on every call, via `DeviceAccessCredentialResolver`. Defaults to a
  ///   real Keychain-backed instance; tests inject a fake-Keychain-backed
  ///   one instead (see `AssistantSceneAssemblyTests.swift`).
  @MainActor
  public static func makeConversationController(
    store: LocalGraphStore,
    credentialStore: AssistantOpenAICredentialStore = AssistantOpenAICredentialStore(),
    deviceCredentialStore: DeviceAccessCredentialStore = DeviceAccessCredentialStore(),
    modelID: String = defaultModelID
  ) -> AssistantConversationController {
    // Two-phase construction (`box` assigned AFTER `AssistantConversationController.init`
    // returns) so `retrievalAuthorization`'s closure can read the just-
    // constructed controller's OWN `messages` at call time — see
    // `AssistantConversationAuthorizationFactory.swift`'s header for why
    // that's the only way this turn's real utterance ever reaches the
    // authorization the app builds "before the request leaves the device."
    // By the time the closure is ever actually invoked (inside a later
    // `send(_:)` call), `box.controller` is always already set, since
    // `send(_:)` cannot run before this function has returned its finished
    // controller to the caller.
    //
    // `ControllerBox.controller` MUST be `weak` (fixed here — an earlier
    // revision made it a strong `var`, a real retain cycle caught by
    // adversarial review): `controller` owns `retrievalAuthorization` as a
    // stored `let`, that closure strongly captures `box`, so a STRONG
    // `box.controller` would close the cycle (controller -> closure -> box
    // -> controller) and leak every assembled controller for the process
    // lifetime — worse than a one-off leak wherever a caller's view
    // identity causes `makeConversationController` to run again. `weak`
    // breaks the cycle safely: the closure is only ever invoked from
    // `send(_:)`, a method ON `controller` itself, so whenever it runs,
    // `controller` (self) is by definition still alive — `box.controller`
    // is never observed `nil` mid-turn, matching this file's own "always
    // already set" claim above.
    let box = ControllerBox()
    let resolver = DeviceAccessCredentialResolver(store: deviceCredentialStore)
    let controller = AssistantConversationController(
      modelID: modelID,
      credential: {
        guard let key = try await credentialStore.readAPIKey(), !key.isEmpty else {
          throw AssistantSceneAssemblyError.noAPIKeyConfigured
        }
        return key
      },
      store: store,
      emailClient: Self.emailClient(resolver: resolver),
      remoteWriteClient: Self.remoteWriteClient(credentialResolver: resolver),
      remoteWriteReviewClient: Self.remoteWriteReviewClient(credentialResolver: resolver),
      taskSnapshotProvider: nil,
      retrievalAuthorization: {
        let utterance = box.controller?.messages.last(where: { $0.role == .user })?.text ?? ""
        return AssistantConversationAuthorizationFactory.retrievalAuthorization(store: store, utterance: utterance)
      },
      writeAuthorization: { AssistantConversationAuthorizationFactory.writeAuthorization }
    )
    box.controller = controller
    return controller
  }

  /// Real, per-call-resolved `VaultEmailSearchClient` — see this file's
  /// header. Constructed with `EnchiridionAPICredentials` derived fresh,
  /// every call, from `resolver.resolveCredential()`.
  public static func emailClient(
    resolver: DeviceAccessCredentialResolver = DeviceAccessCredentialResolver(),
    endpoint: URL = AppBackendConfiguration.graphQLURL
  ) -> VaultEmailSearchClient {
    VaultEmailSearchClient(
      endpoint: endpoint,
      credentialProvider: {
        let credential = try await resolver.resolveCredential()
        return EnchiridionAPICredentials(
          accessClientID: credential.clientId, accessClientSecret: credential.clientSecret)
      })
  }

  /// Real, per-call-resolved `AssistantRemoteWriteClient` — see this file's
  /// header. Propose-only (`AssistantRemoteWriteTransport`); handed
  /// directly to the dispatcher by `makeConversationController` above,
  /// never retained by this type.
  public static func remoteWriteClient(
    credentialResolver: DeviceAccessCredentialResolver = DeviceAccessCredentialResolver(),
    endpoint: AssistantRemoteWriteEndpoint = AssistantRemoteWriteEndpoint(baseURL: AppBackendConfiguration.vaultBaseURL)
  ) -> AssistantRemoteWriteClient {
    AssistantRemoteWriteClient(
      endpoint: endpoint, credential: Self.resolvedRemoteWriteCredential(from: credentialResolver))
  }

  /// Human-confirm-UI-facing sibling of `remoteWriteClient(credentialResolver:endpoint:)`
  /// — see `AssistantRemoteWriteTools.swift`'s header for why this MUST
  /// stay a structurally separate type/value from the one above, never
  /// handed to the assistant's own tool-dispatch path. Retained ONLY by
  /// `AssistantConversationController`'s `confirmProposal(_:)` (see that
  /// file's header) — reached only from an explicit human confirm tap.
  public static func remoteWriteReviewClient(
    credentialResolver: DeviceAccessCredentialResolver = DeviceAccessCredentialResolver(),
    endpoint: AssistantRemoteWriteEndpoint = AssistantRemoteWriteEndpoint(baseURL: AppBackendConfiguration.vaultBaseURL)
  ) -> AssistantRemoteWriteReviewClient {
    AssistantRemoteWriteReviewClient(
      endpoint: endpoint, credential: Self.resolvedRemoteWriteCredential(from: credentialResolver))
  }

  private static func resolvedRemoteWriteCredential(
    from resolver: DeviceAccessCredentialResolver
  ) -> @Sendable () async throws -> AssistantRemoteWriteCredential {
    {
      let credential = try await resolver.resolveCredential()
      return AssistantRemoteWriteCredential(clientId: credential.clientId, clientSecret: credential.clientSecret)
    }
  }

  @MainActor
  private final class ControllerBox {
    weak var controller: AssistantConversationController?
  }
}
