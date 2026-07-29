import EnchiridionCore
import SwiftUI

extension View {
  func presentsTaskCompletionUndo(from store: LibraryStore) -> some View {
    modifier(TaskCompletionUndoModifier(store: store))
  }
}

private struct TaskCompletionUndoModifier: ViewModifier {
  let store: LibraryStore

  @State private var isUndoing = false

  func body(content: Content) -> some View {
    content
      .safeAreaInset(edge: .bottom, spacing: 8) {
        if let offer = store.latestTaskCompletionUndoOffer {
          TaskCompletionUndoBanner(
            offer: offer,
            failureMessage: store.taskCompletionUndoFailure,
            isUndoing: isUndoing,
            undo: performUndo,
            dismiss: dismiss
          )
          .padding(.horizontal)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .animation(
        .easeInOut(duration: 0.18),
        value: store.latestTaskCompletionUndoOffer
      )
  }

  private func performUndo() {
    guard !isUndoing else { return }
    isUndoing = true
    Task { @MainActor in
      _ = await store.undoLatestTaskCompletion()
      isUndoing = false
    }
  }

  private func dismiss() {
    withAnimation {
      store.dismissLatestTaskCompletionUndo()
    }
  }
}

private struct TaskCompletionUndoBanner: View {
  let offer: TaskCompletionUndoOffer
  let failureMessage: String?
  let isUndoing: Bool
  let undo: () -> Void
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(
        systemName: failureMessage == nil ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
      )
      .foregroundStyle(failureMessage == nil ? .green : .orange)
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        Text("Completed \(offer.taskTitle)")
          .lineLimit(2)
        if let failureMessage {
          Text(failureMessage)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Spacer(minLength: 8)

      Button("Undo", action: undo)
        .disabled(isUndoing)

      Button(action: dismiss) {
        Label("Dismiss", systemImage: "xmark")
      }
      .labelStyle(.iconOnly)
      .accessibilityHint("Dismisses the completion confirmation")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .shadow(radius: 8, y: 3)
    .accessibilityElement(children: .contain)
  }
}
