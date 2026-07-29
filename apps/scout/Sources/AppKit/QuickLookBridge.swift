import AppKit
import QuickLookUI
import SwiftUI

struct EmbeddedQuickLookView: NSViewRepresentable {
  let url: URL?

  func makeNSView(context: Context) -> QLPreviewView {
    QLPreviewView(frame: .zero, style: .compact) ?? QLPreviewView(frame: .zero)!
  }

  func updateNSView(_ view: QLPreviewView, context: Context) {
    view.previewItem = url as NSURL?
  }
}

@MainActor
final class QuickLookPanelController: NSObject, @preconcurrency QLPreviewPanelDataSource, QLPreviewPanelDelegate {
  static let shared = QuickLookPanelController()
  private var urls: [URL] = []

  func preview(_ urls: [URL]) {
    guard !urls.isEmpty, let panel = QLPreviewPanel.shared() else { return }
    self.urls = urls
    panel.dataSource = self
    panel.delegate = self
    panel.reloadData()
    panel.currentPreviewItemIndex = 0
    panel.makeKeyAndOrderFront(nil)
  }

  func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { urls.count }

  func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
    urls[index] as NSURL
  }
}
