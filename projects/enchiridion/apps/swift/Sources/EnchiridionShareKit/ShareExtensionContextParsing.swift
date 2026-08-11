// ShareExtensionContextParsing.swift
// EnchiridionShareKit
//
// Turns the raw `NSItemProvider`s a host app's `NSExtensionItem.attachments`
// supplies into a `ShareCaptureInput` — the one piece of glue between a real
// `NSExtensionContext` (iOS/macOS share-extension-only, never constructible
// in a plain `swift test` process — same boundary
// `EnchiridionWidgetKit/README.md` documents for `WidgetTimelineProviderContext`)
// and this target's otherwise-pure capture logic.
//
// UNLIKE that WidgetKit boundary, this one IS testable without a live
// extension host: `NSItemProvider` itself has real, public, non-extension
// initializers (`NSItemProvider(object:)`) usable from any process on
// Darwin, and `URL`/`String` both conform to `NSItemProviderWriting` in
// Foundation — so a test can build a real provider carrying real content
// and exercise the actual `loadItem(forTypeIdentifier:)` round trip, not a
// mock of it. See `ShareExtensionContextParsingTests.swift`.
//
// Deliberately ignores every other UTI a share sheet might offer (images,
// files, etc.) — see this target's README.md "Explicit non-goals" for why
// image sharing is out of scope for v1.
//
// `@MainActor` (not a plain `nonisolated async` function): both real
// callers (`Sources/iOSShareExtension`/`Sources/macOSShareExtension`'s
// `ShareViewController`s) invoke this from their own `@MainActor`-isolated
// `viewDidLoad`/`loadSharedContent`. Under Swift 6's default actor
// isolation, a plain `nonisolated async` function here would instead run
// on the global concurrent executor, and the compiler rejects passing the
// caller's `[NSItemProvider]` (not `Sendable` — `NSItemProvider` predates
// `Sendable` and Apple has not annotated it) across that isolation boundary
// (`sending 'self.attachments' risks causing data races` — confirmed by a
// real `xcodebuild build` failure against `Enchiridion2MacShareExtension`
// before this annotation was added). Pinning this to `@MainActor` matches
// where every real call site already runs and removes the boundary crossing
// entirely; the `NSItemProvider.loadItem` completion handlers underneath
// still fire on whatever queue the system chooses regardless of this
// annotation — `withCheckedContinuation`'s `resume` is safe from any thread
// by design, so nothing here is actually forced onto the main thread that
// wasn't already only reachable from it.
import Foundation
import UniformTypeIdentifiers

@MainActor
public enum ShareExtensionContextParsing {
  /// Extracts a URL and/or plain text from `itemProviders`, taking the
  /// first successfully-loaded value of each kind across all providers (a
  /// share sheet's `NSExtensionItem` can carry several attachments — e.g.
  /// Safari's "Share…" commonly offers both a `public.url` and a
  /// `public.plain-text` attachment for the same page). Any provider that
  /// doesn't carry a given type, or fails to load it, is silently skipped
  /// for that type — a share extension has no good place to surface a
  /// partial-parse error mid-flow, and a URL-only or text-only result is
  /// still a perfectly valid capture (see `ShareCaptureInput.isEmpty`,
  /// which is what actually rejects a genuinely-empty result).
  public static func input(
    from itemProviders: [NSItemProvider],
    pageTitle: String? = nil
  ) async -> ShareCaptureInput {
    var url: URL?
    var text: String?
    for provider in itemProviders {
      if url == nil, let loaded = await loadURL(from: provider) {
        url = loaded
      }
      if text == nil, let loaded = await loadText(from: provider) {
        text = loaded
      }
    }
    return ShareCaptureInput(text: text, url: url, pageTitle: pageTitle)
  }

  /// Deliberately does NOT gate on `hasItemConformingToTypeIdentifier`
  /// first — unnecessary once the `Data` fallback below exists;
  /// attempting the load directly and treating a nil/mismatched/erroring
  /// result as "this provider doesn't have that kind of content" is
  /// simpler.
  ///
  /// The `Data` case is not a defensive afterthought — it's the ACTUAL
  /// shape `loadItem(forTypeIdentifier:)`'s completion handler delivers
  /// for a provider built via `NSItemProvider(object:)` with a plain
  /// `URL`/`NSURL`/`String`/`NSString` payload: the raw UTF-8 bytes of
  /// `URL.absoluteString`/the string itself, not a re-decoded `NSURL`/
  /// `NSString` instance — confirmed by direct experiment against a real
  /// provider (logging `item`'s runtime type showed `Data`, with `error ==
  /// nil`, before this fallback existed; every real-provider test in
  /// `ShareExtensionContextParsingTests.swift` failed with a `nil` result
  /// until this case was added, despite `loadItem` reporting no error at
  /// all — the `default:` branch was silently swallowing it).
  private static func loadURL(from provider: NSItemProvider) async -> URL? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
        switch item {
        case let url as URL: continuation.resume(returning: url)
        case let nsURL as NSURL: continuation.resume(returning: nsURL as URL)
        case let data as Data:
          continuation.resume(
            returning: String(data: data, encoding: .utf8).flatMap { URL(string: $0) })
        default: continuation.resume(returning: nil)
        }
      }
    }
  }

  private static func loadText(from provider: NSItemProvider) async -> String? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
        switch item {
        case let text as String: continuation.resume(returning: text)
        case let nsString as NSString: continuation.resume(returning: nsString as String)
        case let data as Data: continuation.resume(returning: String(data: data, encoding: .utf8))
        default: continuation.resume(returning: nil)
        }
      }
    }
  }
}
