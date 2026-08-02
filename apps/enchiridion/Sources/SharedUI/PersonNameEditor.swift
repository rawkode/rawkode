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
  @State private var activePageID: PageID
  @State private var operationGeneration = 0

  init(page: PageSnapshot, store: LibraryStore) {
    self.page = page
    self.store = store
    _draft = State(initialValue: page.title)
    _activePageID = State(initialValue: page.id)
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

      if let suggestedContactName = store.suggestedLinkedContactName(for: page) {
        Button("Use \u{201C}\(suggestedContactName)\u{201D} as Name") {
          adoptLinkedContactName()
        }
        .disabled(isSaving)
        .accessibilityIdentifier("person-name-editor-use-linked-contact")

        if page.isOtherPerson {
          Text("Using this name adds this Person to your synced library.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
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
    .onChange(of: page.id) { _, pageID in
      activePageID = pageID
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
    operationGeneration &+= 1
    isSaving = false
    draft = page.title
    hasUserEdited = false
    errorMessage = nil
  }

  private func beginOperation(for pageID: PageID) -> Int {
    operationGeneration &+= 1
    isSaving = true
    return operationGeneration
  }

  private func isCurrentOperation(_ generation: Int, for pageID: PageID) -> Bool {
    activePageID == pageID && operationGeneration == generation
  }

  private func finishOperationIfCurrent(_ generation: Int, for pageID: PageID) {
    guard isCurrentOperation(generation, for: pageID) else { return }
    isSaving = false
  }

  private func save() {
    let title = trimmedDraft
    guard !title.isEmpty else {
      errorMessage = "Enter a name before saving."
      return
    }

    let pageID = page.id
    let generation = beginOperation(for: pageID)
    errorMessage = nil
    Task { @MainActor in
      defer { finishOperationIfCurrent(generation, for: pageID) }
      do {
        let updatedPage = try await store.renamePage(pageID: pageID, title: title)
        guard isCurrentOperation(generation, for: pageID), updatedPage.id == pageID else { return }
        draft = updatedPage.title
        hasUserEdited = false
      } catch is CancellationError {
        // Keep the edit available if the surrounding task is cancelled.
      } catch {
        guard isCurrentOperation(generation, for: pageID) else { return }
        errorMessage = error.localizedDescription
      }
    }
  }

  private func adoptLinkedContactName() {
    let pageID = page.id
    let generation = beginOperation(for: pageID)
    Task { @MainActor in
      defer { finishOperationIfCurrent(generation, for: pageID) }
      do {
        let outcome = try await store.adoptLinkedContactName(pageID: pageID)
        guard isCurrentOperation(generation, for: pageID) else { return }
        switch outcome {
        case .adopted(let updatedPage), .unchanged(let updatedPage):
          draft = updatedPage.title
          hasUserEdited = false
          errorMessage = nil
        case .unavailable:
          break
        }
      } catch is CancellationError {
        // Keep the current canonical title visible if the surrounding task is cancelled.
      } catch {
        guard isCurrentOperation(generation, for: pageID) else { return }
        errorMessage = error.localizedDescription
      }
    }
  }
}
