import SwiftUI

/// The create-and-link operation keeps its durable request identities in the model. This local
/// claim only prevents repeated visible activations before the model can publish its busy state.
enum BacklinkCreationPresentation {
    static func isBusy(isModelLinking: Bool, isCreationInFlight: Bool) -> Bool {
        isModelLinking || isCreationInFlight
    }

    static func canStartCreation(isModelLinking: Bool, isCreationInFlight: Bool) -> Bool {
        !isBusy(
            isModelLinking: isModelLinking,
            isCreationInFlight: isCreationInFlight
        )
    }
}

/// Native mirror of `web/src/Backlinks.tsx`: lists nodes/edges linking to today's note via
/// `listBacklinks`, plus a "create a node + link it here" affordance exercising `createNode` +
/// `createEdge` against a lazily-created "mentions" relation definition.
public struct BacklinksView: View {
    @ObservedObject var model: AthenaeumViewModel
    @State private var isBacklinkCreationInFlight = false

    public init(model: AthenaeumViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Backlinks").font(.headline)

            if AthenaeumViewModel.shouldShowBacklinksLoading(
                hasLoadedBacklinks: model.hasLoadedBacklinks,
                errorMessage: model.linkError
            ) {
                ProgressView("Loading backlinks…")
                    .foregroundStyle(.secondary)
            } else if AthenaeumViewModel.shouldShowEmptyBacklinks(
                isEmpty: model.backlinks.isEmpty,
                hasLoadedBacklinks: model.hasLoadedBacklinks,
                errorMessage: model.linkError
            ) {
                Text("No backlinks yet.").foregroundStyle(.secondary).font(.callout)
            } else {
                ForEach(model.backlinks) { row in
                    HStack {
                        Text(row.sourceTitle).bold()
                        Text("mentions this note").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            HStack {
                TextField("New node title — links here as a backlink", text: $model.newBacklinkTitle)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isCreatingBacklink)
                Button(isCreatingBacklink ? "Linking…" : "Create + link") {
                    startBacklinkCreation()
                }
                .disabled(
                    isCreatingBacklink ||
                        model.newBacklinkTitle.trimmingCharacters(in: .whitespaces).isEmpty
                )
            }

            if let error = model.linkError {
                Text(error).foregroundStyle(.red).font(.caption)
            }
        }
    }

    private var isCreatingBacklink: Bool {
        BacklinkCreationPresentation.isBusy(
            isModelLinking: model.isLinkingBacklink,
            isCreationInFlight: isBacklinkCreationInFlight
        )
    }

    private func startBacklinkCreation() {
        guard BacklinkCreationPresentation.canStartCreation(
            isModelLinking: model.isLinkingBacklink,
            isCreationInFlight: isBacklinkCreationInFlight
        ) else { return }

        isBacklinkCreationInFlight = true
        Task { @MainActor in
            defer { isBacklinkCreationInFlight = false }
            await model.createAndLinkBacklink()
        }
    }
}
