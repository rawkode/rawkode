import AppKit
import Foundation
import QuickLookThumbnailing

@MainActor
protocol ThumbnailClient: Sendable {
  func thumbnail(for url: URL, size: CGSize, scale: CGFloat) async -> NSImage
}

@MainActor
struct QuickLookThumbnailClient: ThumbnailClient {
  func thumbnail(for url: URL, size: CGSize, scale: CGFloat) async -> NSImage {
    let request = QLThumbnailGenerator.Request(
      fileAt: url,
      size: size,
      scale: scale,
      representationTypes: [.icon, .thumbnail]
    )
    do {
      let representation = try await QLThumbnailGenerator.shared.generateBestRepresentation(for: request)
      return representation.nsImage
    } catch {
      return NSWorkspace.shared.icon(forFile: url.path)
    }
  }
}
