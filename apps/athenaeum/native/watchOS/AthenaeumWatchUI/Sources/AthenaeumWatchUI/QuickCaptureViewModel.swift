import Foundation

// The watchOS mirror of `AthenaeumApp/Sources/AthenaeumAppUI/AthenaeumViewModel.swift`'s role —
// a `@MainActor` `ObservableObject` driving SwiftUI's `@Published`-based render loop — but scoped
// to exactly one action (`capture`), since the watch app has no editor/backlinks/graph-view
// screens at all, per this stage's task scope.

@MainActor
public final class QuickCaptureViewModel: ObservableObject {
    public enum SubmitState: Equatable {
        case idle
        case submitting
        case success(title: String)
        case error(String)
    }

    @Published public var draftText: String = ""
    @Published public private(set) var state: SubmitState = .idle

    private let client: QuickCaptureClient

    public init(client: QuickCaptureClient = QuickCaptureClient()) {
        self.client = client
    }

    /// Runs on the watch app's "Save"/submit action. Clears the draft and shows a brief success
    /// state on a real server round trip; leaves the draft text intact on failure so nothing
    /// dictated is lost to a network blip (see `QuickCaptureClient`'s doc comment on why there's
    /// no local retry queue underneath this — the failure surfaces here instead).
    public func submit() async {
        let text = draftText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        state = .submitting
        do {
            let capture = try await client.capture(text: text)
            draftText = ""
            state = .success(title: capture.node.title)
        } catch {
            state = .error(String(describing: error))
        }
    }

    /// Dismisses a terminal `.success`/`.error` state back to `.idle` — called after the view's
    /// brief confirmation UI has been shown, so a second capture starts from a clean slate.
    public func acknowledge() {
        state = .idle
    }
}
