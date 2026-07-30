import Foundation

@MainActor
protocol ICloudDriveProviding {
  /// Scout's app-owned iCloud Drive Documents directory, if the current account
  /// and the app's iCloud container are both available.
  func rootURL() -> URL?
}

@MainActor
struct SystemICloudDriveProvider: ICloudDriveProviding {
  static let containerIdentifier = "iCloud.dev.rawkode.scout"

  func rootURL() -> URL? {
    guard FileManager.default.ubiquityIdentityToken != nil,
          let container = FileManager.default.url(
            forUbiquityContainerIdentifier: Self.containerIdentifier
          )
    else {
      return nil
    }

    return container.appending(path: "Documents", directoryHint: .isDirectory)
  }
}
