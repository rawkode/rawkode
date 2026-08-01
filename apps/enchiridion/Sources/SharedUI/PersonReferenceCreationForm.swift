import EnchiridionCore
import SwiftUI

/// The small, name-first form used when turning selected text into a Person reference.
///
/// The form deliberately keeps the source text as data: an email can seed the Person's
/// Email property, but it is never used as a guessed name and is never auto-linked.
@MainActor
struct PersonReferenceCreationForm: View {
  let selectedSourceText: String
  let store: LibraryStore
  let isDisabled: Bool
  let nameFocus: FocusState<Bool>.Binding?
  let candidateRefreshToken: UUID
  let onCreate: (String, String?) -> Void
  let onLink: (PersonEmailCandidate) -> Void

  @State private var name = ""
  @State private var candidates: [PersonEmailCandidate] = []
  @State private var isLoadingCandidates = false
  @State private var loadError: String?
  @State private var hasCompletedCandidateLookup = false
  @State private var lookupToken = UUID()
  @FocusState private var localNameFocus: Bool

  init(
    selectedSourceText: String,
    store: LibraryStore,
    isDisabled: Bool,
    nameFocus: FocusState<Bool>.Binding? = nil,
    candidateRefreshToken: UUID,
    onCreate: @escaping (String, String?) -> Void,
    onLink: @escaping (PersonEmailCandidate) -> Void
  ) {
    self.selectedSourceText = selectedSourceText
    self.store = store
    self.isDisabled = isDisabled
    self.nameFocus = nameFocus
    self.candidateRefreshToken = candidateRefreshToken
    self.onCreate = onCreate
    self.onLink = onLink
  }

  private var normalizedEmail: String? {
    try? PersonEmail.normalize(selectedSourceText)
  }

  private var trimmedName: String {
    name.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canCreate: Bool {
    guard !isDisabled, !trimmedName.isEmpty else { return false }
    guard normalizedEmail != nil else { return true }
    return hasCompletedCandidateLookup
      && !isLoadingCandidates
      && loadError == nil
      && candidates.isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Create Person")
        .font(.headline)
        .accessibilityAddTraits(.isHeader)

      TextField("Name", text: $name)
        .textFieldStyle(.roundedBorder)
        .focused(nameFocus ?? $localNameFocus)
        .disabled(isDisabled)
        .accessibilityLabel("Person name")
        .accessibilityHint("Enter the person's name. The selected text is not used as a name.")
        .accessibilityIdentifier("person-reference-name")

      if let email = normalizedEmail {
        LabeledContent("Email", value: email)
          .foregroundStyle(.secondary)
          .accessibilityElement(children: .combine)
          .accessibilityLabel("Email, \(email)")
          .accessibilityIdentifier("person-reference-email")
      } else if !selectedSourceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text("The selected text is not a valid email address.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("person-reference-no-email")
      }

      if isLoadingCandidates {
        ProgressView("Checking existing People…")
          .controlSize(.small)
          .accessibilityIdentifier("person-reference-loading")
      } else if !candidates.isEmpty {
        candidateSection
      }

      if let loadError {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Label(loadError, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(.red)
            .accessibilityLabel("Could not check existing People. \(loadError)")

          Button("Try Again") {
            lookupToken = UUID()
          }
          .buttonStyle(.borderless)
          .disabled(isDisabled)
          .accessibilityLabel("Retry existing People lookup")
          .accessibilityIdentifier("person-reference-retry")
        }
        .accessibilityIdentifier("person-reference-error")
      }

      HStack {
        Button("Create Person", systemImage: "person.crop.circle.badge.plus") {
          onCreate(trimmedName, normalizedEmail)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canCreate)
        .accessibilityIdentifier("person-reference-create")

        if normalizedEmail != nil && (!candidates.isEmpty || isLoadingCandidates || loadError != nil) {
          Text("To avoid duplicates, link an existing Person or wait for the email check to finish.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .task(id: lookupToken) {
      await loadCandidates(
        email: normalizedEmail,
        token: lookupToken
      )
    }
    .onChange(of: selectedSourceText) { _, _ in
      lookupToken = UUID()
    }
    .onChange(of: candidateRefreshToken) { _, _ in
      lookupToken = UUID()
    }
    .onAppear {
      #if os(iOS)
      nameFocus?.wrappedValue = true
      #endif
    }
    .accessibilityIdentifier("person-reference-creation-form")
  }

  private var candidateSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Existing People")
        .font(.subheadline.weight(.semibold))
        .accessibilityAddTraits(.isHeader)

      ForEach(candidates) { candidate in
        Button {
          onLink(candidate)
        } label: {
          HStack(spacing: 10) {
            Image(systemName: "person.crop.circle")
              .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
              Text(candidate.displayName)
                .frame(maxWidth: .infinity, alignment: .leading)
              Text(candidate.email)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Image(systemName: "arrow.right")
              .foregroundStyle(.secondary)
          }
        }
        .buttonStyle(.bordered)
        .disabled(isDisabled)
        .accessibilityLabel("Link to Person, \(candidate.displayName), \(candidate.email)")
        .accessibilityHint("Uses this existing Person; it does not create or merge a record.")
        .accessibilityIdentifier("person-reference-candidate-\(candidate.id)")
      }
    }
  }

  @MainActor
  private func loadCandidates(email: String?, token: UUID) async {
    guard token == lookupToken else { return }
    guard let email else {
      candidates = []
      isLoadingCandidates = false
      loadError = nil
      hasCompletedCandidateLookup = false
      return
    }

    isLoadingCandidates = true
    loadError = nil
    candidates = []
    hasCompletedCandidateLookup = false
    defer {
      if token == lookupToken {
        isLoadingCandidates = false
      }
    }

    do {
      let loadedCandidates = try await store.personEmailCandidates(matchingEmail: email)
      guard !Task.isCancelled, token == lookupToken else { return }
      candidates = loadedCandidates
      hasCompletedCandidateLookup = true
    } catch is CancellationError {
      return
    } catch {
      guard !Task.isCancelled, token == lookupToken else { return }
      candidates = []
      loadError = error.localizedDescription
    }
  }
}
