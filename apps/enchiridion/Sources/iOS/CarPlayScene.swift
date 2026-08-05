import CarPlay
import UIKit

final class EnchiridionAppDelegate: NSObject, UIApplicationDelegate {
  private let workoutTransport = WorkoutWatchConnectivityTransport()

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    TaskReminderNotificationCoordinator.shared.configure(
      store: EnchiridionAppRuntime.shared.store,
      resolveStore: { vaultID in
        try await EnchiridionAppRuntime.shared.vaultSession?.backgroundStore(forVault: vaultID)
      },
      openURL: { url in
        UIApplication.shared.open(url)
      }
    )
    if let session = EnchiridionAppRuntime.shared.vaultSession,
      let receiver = try? WorkoutPhoneReceiver(
        vaultSession: session,
        registry: session.catalog,
        acknowledgementSender: workoutTransport
      )
    {
      workoutTransport.start(receiver: receiver)
    }
    Task { await EnchiridionAppRuntime.shared.refreshBookmarkCaptures() }
    return true
  }

  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: connectingSceneSession.role == .carTemplateApplication
        ? "CarPlay Voice" : "Default Configuration",
      sessionRole: connectingSceneSession.role
    )

    if connectingSceneSession.role == .carTemplateApplication {
      configuration.sceneClass = CPTemplateApplicationScene.self
      configuration.delegateClass = CarPlaySceneDelegate.self
    }

    return configuration
  }
}

@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    EnchiridionAppRuntime.shared.carPlayVoice.connect(to: interfaceController)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    EnchiridionAppRuntime.shared.carPlayVoice.disconnect()
  }

  func sceneWillResignActive(_ scene: UIScene) {
    EnchiridionAppRuntime.shared.carPlayVoice.pauseForSafety(reason: .sceneInactive)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    EnchiridionAppRuntime.shared.carPlayVoice.resumeAfterBecomingActive()
  }
}
