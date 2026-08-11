// UnicodeScalarOffsets.swift
// EnchiridionUI
//
// `PageDocument.insertText`/`deleteText`/`mark` (EnchiridionSync) address
// text by "unicode position" (see that file's doc comments, quoting
// loro-swift's `LoroTextProtocol.delete(pos:len:)`: "Delete a range of text
// at the given unicode position with unicode length"). Loro's Rust core
// indexes text by Unicode Scalar Value (the same unit as a Rust `char`),
// which is neither Swift's `Character` (extended grapheme cluster — one
// `Character` can be several scalars, e.g. a flag emoji or a modifier
// sequence) nor UTF-16 code units (`NSString`/`String.utf16` — one scalar
// outside the BMP is two UTF-16 units). Every position/length this module
// hands to `PageDocument` is therefore expressed in Unicode Scalar offsets,
// computed with these helpers — never `String.count` or `.utf16.count`.
extension String {
  /// This string's length in Unicode Scalar Values — the unit `PageDocument`
  /// positions and lengths are expressed in.
  var scalarCount: Int {
    unicodeScalars.count
  }

  /// The `String.Index` at Unicode Scalar offset `offset` from the start.
  /// `String.UnicodeScalarView.Index` and `String.Index` are the same type
  /// in Swift's unified index model, so this is directly usable for
  /// slicing (`self[...]`) or grapheme-boundary-aware operations.
  func index(atScalarOffset offset: Int) -> Index {
    unicodeScalars.index(unicodeScalars.startIndex, offsetBy: offset)
  }

  /// The Unicode Scalar offset of `index` from the start of the string.
  func scalarOffset(of index: Index) -> Int {
    unicodeScalars.distance(from: unicodeScalars.startIndex, to: index)
  }

  /// Converts a Unicode-Scalar-offset `Range<Int>` (a `PageDocument`-style
  /// position/length pair, already combined into a range) into a
  /// `Range<String.Index>` usable for slicing this string.
  func stringRange(_ scalarRange: Range<Int>) -> Range<Index> {
    index(atScalarOffset: scalarRange.lowerBound)..<index(atScalarOffset: scalarRange.upperBound)
  }
}
