import Foundation

// Swift mirror of `web/src/automerge-page.ts`'s `diffText` — turns a SwiftUI `TextEditor`'s
// `Binding<String>` (which, like a controlled `<textarea>`, only ever hands back the resulting
// full string on change) into the `(index, deleteCount, insertText)` op
// `PageDocumentStore.applyLocalSplice` wants.
//
// **Deliberately indexes over UTF-16 code units, not `Character`s (extended grapheme clusters)**:
// `PageDocumentStore.applyLocalSplice`'s own doc comment states its `index`/`deleteCount`
// contract as "UTF-16 code units... the exact `(index, deleteCount, insertText)` shape
// `ApplyPageEditInput`... and `web/src/automerge-page.ts`'s `applyLocalSplice` both use" — because
// JS strings (and thus the wire protocol both clients converge on) are UTF-16 sequences. Swift's
// native `String` indexing is grapheme-cluster-based, which does not agree with JS/UTF-16
// indexing for any text containing multi-code-unit graphemes (combining marks, most emoji) — using
// `Character`-based indices here would silently corrupt the CRDT position for exactly that text,
// so this diff (and every offset it produces) operates on `[UInt16]` (`String.utf16`) throughout.
public struct TextEdit: Equatable {
    public let index: Int
    public let deleteCount: Int
    public let insertText: String
}

/// Smallest common-prefix/suffix single-region diff between two full-text UTF-16 snapshots.
/// Returns `nil` if the strings are identical. See this file's top doc comment for why UTF-16.
public func diffText(before: String, after: String) -> TextEdit? {
    if before == after { return nil }

    let beforeUnits = Array(before.utf16)
    let afterUnits = Array(after.utf16)
    let maxCommon = min(beforeUnits.count, afterUnits.count)

    var prefix = 0
    while prefix < maxCommon, beforeUnits[prefix] == afterUnits[prefix] {
        prefix += 1
    }

    let maxSuffix = maxCommon - prefix
    var suffix = 0
    while suffix < maxSuffix,
          beforeUnits[beforeUnits.count - 1 - suffix] == afterUnits[afterUnits.count - 1 - suffix] {
        suffix += 1
    }

    let deleteCount = beforeUnits.count - prefix - suffix
    let insertUnits = Array(afterUnits[prefix..<(afterUnits.count - suffix)])
    let insertText = String(utf16CodeUnits: insertUnits, count: insertUnits.count)

    return TextEdit(index: prefix, deleteCount: deleteCount, insertText: insertText)
}
