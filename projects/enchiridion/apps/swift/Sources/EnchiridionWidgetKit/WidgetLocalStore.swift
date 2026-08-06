// WidgetLocalStore.swift
// EnchiridionWidgetKit
//
// Lazily opens, once per widget-extension process, the App-Group-shared
// `LocalGraphStore` both widgets read from
// (`EnchiridionStore/LocalGraphStoreLocation.swift`). WidgetKit extensions
// are short-lived, repeatedly re-launched processes driven by
// `TimelineProvider.getTimeline`/`getSnapshot` calls — a `static let` here
// is the simplest safe-once-per-process pattern (mirrors the old app's
// `TodayTasksWidget.swift` calling `VaultRepositoryContext.open(...)` once
// per `loadEntry()`, minus its multi-vault selection machinery, which this
// rebuild's single-vault-per-device model doesn't have).
//
// `Result`, not a throwing computed property: every call site
// (`WidgetEntryDataSource`'s two `load...Entry` functions) needs to turn a
// missing/unopenable store into a widget-appropriate "not set up yet"
// entry rather than crashing the extension process — matching this
// package's existing posture that a read tool's caller decides how to
// present a failure, never a fatalError in library code.

import EnchiridionStore
import Foundation

enum WidgetLocalStore {
  static let shared: Result<LocalGraphStore, Error> = Result { try LocalGraphStore.openAppGroupStore() }
}
