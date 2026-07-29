import EnchiridionCore
import SwiftUI

extension View {
  func presentsTaskCompletionUndo(from store: LibraryStore) -> some View {
    modifier(TaskCompletionUndoModifier(store: store))
  }
}

private struct TaskCompletionUndoModifier: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

  let store: LibraryStore

  @State private var isUndoing = false

  func body(content: Content) -> some View {
    content
      .safeAreaInset(edge: .bottom, spacing: 8) {
        if let offer = store.latestProjectClosureUndoOffer {
          LifecycleUndoBanner(
            title: projectClosureTitle(offer),
            detailMessage: projectClosureDetail(offer),
            failureMessage: store.projectClosureUndoFailure,
            isUndoing: isUndoing,
            undo: performProjectClosureUndo,
            dismiss: dismissProjectClosure,
            dismissHint: "Dismisses the project closure confirmation"
          )
          .padding(.horizontal)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if let offer = store.latestTaskCompletionUndoOffer {
          LifecycleUndoBanner(
            title: "Completed \(offer.taskTitle)",
            detailMessage: nil,
            failureMessage: store.taskCompletionUndoFailure,
            isUndoing: isUndoing,
            undo: performTaskCompletionUndo,
            dismiss: dismissTaskCompletion,
            dismissHint: "Dismisses the completion confirmation"
          )
          .padding(.horizontal)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .animation(
        accessibilityReduceMotion ? nil : .easeInOut(duration: 0.18),
        value: store.latestTaskCompletionUndoOffer
      )
      .animation(
        accessibilityReduceMotion ? nil : .easeInOut(duration: 0.18),
        value: store.latestProjectClosureUndoOffer
      )
  }

  private func performTaskCompletionUndo() {
    guard !isUndoing else { return }
    isUndoing = true
    Task { @MainActor in
      _ = await store.undoLatestTaskCompletion()
      isUndoing = false
    }
  }

  private func performProjectClosureUndo() {
    guard !isUndoing else { return }
    isUndoing = true
    Task { @MainActor in
      _ = await store.undoLatestProjectClosure()
      isUndoing = false
    }
  }

  private func dismissTaskCompletion() {
    withAnimation(accessibilityReduceMotion ? nil : .easeInOut(duration: 0.18)) {
      store.dismissLatestTaskCompletionUndo()
    }
  }

  private func dismissProjectClosure() {
    withAnimation(accessibilityReduceMotion ? nil : .easeInOut(duration: 0.18)) {
      store.dismissLatestProjectClosureUndo()
    }
  }

  private func projectClosureTitle(_ offer: ProjectClosureUndoOffer) -> String {
    guard offer.resolution == .cancelActiveTasks else {
      return "Completed \(offer.projectTitle)"
    }
    guard offer.affectedTaskCount > 0 else { return "Cancelled \(offer.projectTitle)" }
    return
      "Cancelled \(offer.projectTitle) and \(offer.affectedTaskCount) \(offer.affectedTaskCount == 1 ? "task" : "tasks")"
  }

  private func projectClosureDetail(_ offer: ProjectClosureUndoOffer) -> String? {
    guard offer.resolution == .detachActiveTasks, offer.affectedTaskCount > 0 else { return nil }
    return
      "\(offer.affectedTaskCount) \(offer.affectedTaskCount == 1 ? "task remains" : "tasks remain") active in \(offer.affectedTaskCount == 1 ? "its" : "their") current lists."
  }
}

private struct LifecycleUndoBanner: View {
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  let title: String
  let detailMessage: String?
  let failureMessage: String?
  let isUndoing: Bool
  let undo: () -> Void
  let dismiss: () -> Void
  let dismissHint: String

  @AccessibilityFocusState private var messageIsFocused: Bool

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 10) {
          message
          HStack(spacing: 8) {
            Spacer(minLength: 0)
            actions
          }
        }
      } else {
        HStack(spacing: 12) {
          message
          Spacer(minLength: 8)
          actions
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .shadow(radius: 8, y: 3)
    .accessibilityElement(children: .contain)
    .task(id: accessibilityAnnouncementID) {
      await Task.yield()
      messageIsFocused = true
    }
  }

  private var message: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(
        systemName: failureMessage == nil ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
      )
      .foregroundStyle(failureMessage == nil ? .green : .orange)
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .fixedSize(horizontal: false, vertical: true)
        if let message = failureMessage ?? detailMessage {
          Text(message)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityFocused($messageIsFocused)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var actions: some View {
    HStack(spacing: 8) {
      Button(isUndoing ? "Undoing…" : "Undo", action: undo)
        .disabled(isUndoing)
        .frame(minHeight: 44)

      Button(action: dismiss) {
        Label("Dismiss", systemImage: "xmark")
      }
      .labelStyle(.iconOnly)
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityHint(dismissHint)
    }
  }

  private var accessibilityAnnouncementID: String {
    [title, detailMessage, failureMessage].compactMap { $0 }.joined(separator: "|")
  }
}
