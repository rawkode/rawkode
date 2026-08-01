import EnchiridionCore
import SwiftUI

/// An explicit, transactional editor for a Person's canonical page name.
@MainActor
struct PersonNameEditor: View {
  let page: PageSnapshot
  let store: LibraryStore

  @State private var draft: String
  @State private var hasUserEdited = false
  @State private var isSaving = false
  @State private var errorMessage: String?

  init(page: PageSnapshot, store: LibraryStore) {
    self.page = page
    self.store = store
    _draft = State(initialValue: store.personDisplayName(for: page))
  }

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        TextField("Name", text: draftBinding)
          .textFieldStyle(.roundedBorder)
          .disabled(isSaving)
          .accessibilityLabel("Person name")
          .accessibilityIdentifier("person-name-editor-field")

        Button("Save") {
          save()
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSaving || trimmedDraft.isEmpty || !hasUserEdited)
        .accessibilityIdentifier("person-name-editor-save")
      }

      if isSaving {
        ProgressView("Saving…")
          .controlSize(.small)
          .accessibilityIdentifier("person-name-editor-saving")
      }

      if let errorMessage {
        Label(errorMessage, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.red)
          .accessibilityLabel("Could not save person name. \(errorMessage)")
          .accessibilityIdentifier("person-name-editor-error")
      }
    }
    .onChange(of: page.id) { _, _ in
      resetFromPage()
    }
    .onChange(of: page.title) { _, _ in
      guard !hasUserEdited, !isSaving else { return }
      resetFromPage()
    }
    .accessibilityIdentifier("person-name-editor")
  }

  private var draftBinding: Binding<String> {
    Binding(
      get: { draft },
      set: {
        draft = $0
        hasUserEdited = true
        errorMessage = nil
      }
    )
  }

  private func resetFromPage() {
    draft = store.personDisplayName(for: page)
    hasUserEdited = false
    errorMessage = nil
  }

  private func save() {
    let title = trimmedDraft
    guard !title.isEmpty else {
      errorMessage = "Enter a name before saving."
      return
    }

    isSaving = true
    errorMessage = nil
    Task { @MainActor in
      do {
        let updatedPage = try await store.renamePage(pageID: page.id, title: title)
        guard updatedPage.id == page.id else { return }
        draft = store.personDisplayName(for: updatedPage)
        hasUserEdited = false
      } catch is CancellationError {
        // Keep the edit available if the surrounding task is cancelled.
      } catch {
        errorMessage = error.localizedDescription
      }
      isSaving = false
    }
  }
}
