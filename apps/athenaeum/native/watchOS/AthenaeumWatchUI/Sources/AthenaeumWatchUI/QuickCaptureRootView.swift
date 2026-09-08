import SwiftUI

/// The one view `native/watchOS/App`'s `@main App` shell embeds directly in a watch
/// `WindowGroup` — mirrors `AthenaeumAppUI.AthenaeumRootView`'s role, but simpler: unlike
/// `AthenaeumViewModel.init` (which opens/migrates a real local SQLite file and can throw),
/// `QuickCaptureViewModel.init`/`QuickCaptureClient.init` never fail synchronously — there is no
/// on-device store to open here (see `QuickCaptureClient`'s doc comment), so there is no
/// throwing-construction error screen to show.
public struct QuickCaptureRootView: View {
    @StateObject private var model = QuickCaptureViewModel()

    public init() {}

    public var body: some View {
        QuickCaptureView(model: model)
    }
}
