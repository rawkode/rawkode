import SwiftUI

/// Native mirror of `web/src/Backlinks.tsx`: lists nodes/edges linking to today's note via
/// `listBacklinks`, plus a "create a node + link it here" affordance exercising `createNode` +
/// `createEdge` against a lazily-created "mentions" relation definition.
public struct BacklinksView: View {
    @ObservedObject var model: AthenaeumViewModel

    public init(model: AthenaeumViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Backlinks").font(.headline)

            if model.backlinks.isEmpty {
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
                    .disabled(model.isLinkingBacklink)
                Button(model.isLinkingBacklink ? "Linking…" : "Create + link") {
                    Task { await model.createAndLinkBacklink() }
                }
                .disabled(model.isLinkingBacklink || model.newBacklinkTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if let error = model.linkError {
                Text(error).foregroundStyle(.red).font(.caption)
            }
        }
    }
}
