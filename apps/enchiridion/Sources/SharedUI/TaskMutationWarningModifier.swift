import EnchiridionCore
import SwiftUI

#if os(iOS)
  import UIKit
#endif

extension View {
  func presentsTaskMutationWarnings(from store: LibraryStore) -> some View {
    modifier(TaskMutationWarningModifier(store: store))
  }
}

private struct TaskMutationWarningModifier: ViewModifier {
  @Environment(\.openURL) private var openURL
  @State private var presentedWarning: TaskMutationWarningPresentation?

  let store: LibraryStore

  func body(content: Content) -> some View {
    content
      .onChange(of: store.taskMutationWarnings, initial: true) { _, warnings in
        let next = TaskMutationWarningPresentation.make(warnings: warnings)
        guard next != presentedWarning else { return }
        presentedWarning = next
      }
      .alert(item: warningBinding) { warning in
        if let recovery = warning.recovery {
          return Alert(
            title: Text(warning.title),
            message: Text(warning.message),
            primaryButton: .default(Text(recovery.title)) {
              store.acknowledgeTaskMutationWarnings()
              perform(recovery)
            },
            secondaryButton: .cancel(Text("OK")) {
              store.acknowledgeTaskMutationWarnings()
            }
          )
        }
        return Alert(
          title: Text(warning.title),
          message: Text(warning.message),
          dismissButton: .cancel(Text("OK")) {
            store.acknowledgeTaskMutationWarnings()
          }
        )
      }
  }

  private var warningBinding: Binding<TaskMutationWarningPresentation?> {
    Binding(
      get: { presentedWarning },
      set: { warning in
        presentedWarning = warning
        if warning == nil {
          store.acknowledgeTaskMutationWarnings()
        }
      }
    )
  }

  private func perform(_ recovery: TaskMutationWarningRecovery) {
    switch recovery {
    case .notificationsSettings:
      guard let url = notificationsSettingsURL else { return }
      openURL(url)
    case .retryPendingEffects:
      Task { @MainActor in
        await Task.yield()
        await store.retryPendingTaskEffects()
        presentedWarning = TaskMutationWarningPresentation.make(
          warnings: store.taskMutationWarnings
        )
      }
    }
  }

  private var notificationsSettingsURL: URL? {
    #if os(iOS)
      URL(string: UIApplication.openNotificationSettingsURLString)
    #elseif os(macOS)
      let bundleID = Bundle.main.bundleIdentifier ?? "dev.rawkode.enchiridion"
      let encodedBundleID =
        bundleID.addingPercentEncoding(
          withAllowedCharacters: .urlQueryAllowed
        ) ?? bundleID
      return URL(
        string:
          "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(encodedBundleID)"
      )
    #else
      nil
    #endif
  }
}

extension TaskMutationWarningRecovery {
  fileprivate var title: String {
    switch self {
    case .notificationsSettings: "Notifications Settings"
    case .retryPendingEffects: "Retry"
    }
  }
}
