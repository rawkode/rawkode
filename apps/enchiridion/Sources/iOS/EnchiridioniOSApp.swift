import EnchiridionCore
import SwiftUI
import UIKit

@main
struct EnchiridioniOSApp: App {
  @UIApplicationDelegateAdaptor(EnchiridionAppDelegate.self) private var appDelegate

  var body: some Scene {
    WindowGroup {
      MobileRootView(store: EnchiridionAppRuntime.shared.store)
    }
  }
}

@MainActor
final class EnchiridionAppRuntime {
  static let shared = EnchiridionAppRuntime()

  let repository: LibraryRepository?
  let store: LibraryStore
  let assistant: FoundationModelAssistant?
  let repositoryError: String?
  lazy var carPlayVoice = CarPlayVoiceCoordinator(
    assistant: assistant,
    repositoryError: repositoryError
  )

  private init() {
    do {
      let repository = try LibraryRepository(path: LibraryRepository.defaultLocalPath())
      self.repository = repository
      store = LibraryStore(repository: repository)
      assistant = FoundationModelAssistant(repository: repository)
      repositoryError = nil
    } catch {
      repository = nil
      store = LibraryStore()
      assistant = nil
      repositoryError = error.localizedDescription
    }
  }
}
