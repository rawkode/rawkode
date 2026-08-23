import SwiftUI
import AthenaeumDomain

/// Native mirror of `web/src/DailyNote.tsx`: resolves/creates today's note (via
/// `AthenaeumViewModel.start()`), a real text editor bound to the local Automerge `Text` CRDT
/// (`AthenaeumCore.PageDocumentStore`, through `AthenaeumViewModel.handleTextChange`), a sync
/// status line, and its own nested `BacklinksView` — same composition `DailyNote.tsx` uses.
public struct DailyNoteView: View {
    @ObservedObject var model: AthenaeumViewModel

    public init(model: AthenaeumViewModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Daily note — \(localDateStamp(Date()))")
                .font(.title2.bold())

            switch model.status {
            case .loading:
                ProgressView("Resolving today's note…")
            case .error(let message):
                Text(message)
                    .foregroundStyle(.red)
            default:
                if model.isRichTextReadOnly {
                    richTextBanner
                }
                editor
                statusLine
                BacklinksView(model: model)
            }
        }
        .padding()
    }

    /// **Native safety pass** (`docs/rich-text-editor-decisions.md` item 6): shown whenever
    /// `AthenaeumViewModel.isRichTextReadOnly` is set — this note uses the web rich-text editor's
    /// block/mark-shaped document, which native's flat-Text editor must never locally edit (a
    /// proven corruption risk, not a hypothetical one — see `RichTextCompatTests.swift`).
    private var richTextBanner: some View {
        HStack(spacing: 6) {
            Image(systemName: "text.badge.xmark").foregroundStyle(.orange)
            Text("This note has rich formatting — edit it on the web app for now.")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(.orange.opacity(0.12)))
    }

    private var editor: some View {
        TextEditor(text: Binding(
            get: { model.text },
            set: { model.handleTextChange($0) }
        ))
        .font(.body.monospaced())
        .frame(minHeight: 220)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.secondary.opacity(0.3)))
        // Belt-and-braces alongside `AthenaeumViewModel.handleTextChange`'s own guard: a rich
        // note's `TextEditor` is never interactable at all, not just rejected on commit — no
        // garbled U+FFFC glyphs are ever exposed to a real editing cursor.
        .disabled(model.isRichTextReadOnly)
        .opacity(model.isRichTextReadOnly ? 0.6 : 1)
    }

    private var statusLine: some View {
        HStack(spacing: 6) {
            switch model.status {
            case .syncing:
                ProgressView().controlSize(.small)
                Text("Syncing…")
            case .synced:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text("Synced")
            case .error(let message):
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text("Sync failed: \(message)")
            default:
                EmptyView()
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}
