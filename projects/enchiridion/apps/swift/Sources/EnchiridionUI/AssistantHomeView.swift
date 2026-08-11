// AssistantHomeView.swift
// EnchiridionUI
//
// Task #85 (P7 integration wave, track 4 — "Assistant reachability"). The
// real "Assistant" navigation destination: hosts the real, P5-built
// `AssistantConversationView` unmodified over a real
// `AssistantConversationController`. This is the single most important
// wiring in the whole P7 integration task — before this file (and
// `RootView.swift` presenting it), `AssistantConversationController`/
// `AssistantConversationView` had been fully built and tested since P5 with
// NO real call site anywhere in the running app (P5's own "Tracked, not
// fixed" note, and this task's brief).
//
// TASK #91 UPDATE — CONTROLLER OWNERSHIP MOVED OUT OF THIS VIEW: this type
// used to construct its own `AssistantConversationController` via
// `AssistantSceneAssembly.makeConversationController(store:)` inside a
// `.task`, guarded by `@State private var controller: AssistantConversationController?
// == nil`. That was a real, HIGH-severity data-loss bug on macOS: `Sources
// /macOS/RootView.swift`'s `NavigationSplitView` renders exactly one
// destination at a time inside a conditional `switch`, and standard SwiftUI
// branch-identity semantics tear down and rebuild whichever case isn't
// selected — so navigating away from "Assistant" and back produced a BRAND
// NEW `AssistantHomeView` with `controller == nil`, silently discarding the
// entire conversation transcript AND any pending unconfirmed write
// proposal the person hadn't tapped "confirm" on yet. (iOS never had this
// problem: `Sources/iOS/RootView.swift`'s `TabView` over
// `ForEach(RootTab.allCases)` keeps all three tab roots — and therefore
// this view's `@State` — resident for the app's lifetime.)
//
// The fix: this view no longer owns or constructs the controller at all.
// Both `RootView`s now hoist a single `AssistantConversationController`
// into their own `@State`, built once (alongside the shared `LocalGraphStore`)
// above wherever destination-switching happens, and hand it down here as a
// plain, already-alive value — so it survives macOS's `NavigationSplitView`
// destination rebuilds exactly the way it already survived iOS's `TabView`
// tab switches. See `Sources/macOS/RootView.swift` / `Sources/iOS
// /RootView.swift` and `AssistantSceneAssembly.swift`'s header (the `weak
// var box.controller` retain-cycle fix is unaffected by this change — there
// is still exactly one `AssistantConversationController` per app launch,
// now constructed once instead of once per destination rebuild).
import SwiftUI

public struct AssistantHomeView: View {
  private let controller: AssistantConversationController

  public init(controller: AssistantConversationController) {
    self.controller = controller
  }

  public var body: some View {
    AssistantConversationView(controller: controller)
  }
}
