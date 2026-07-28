import CarPlay
import UIKit

final class EnchiridionAppDelegate: NSObject, UIApplicationDelegate {
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
}
