// BlobReference.swift
// EnchiridionBlobs
//
// Content-addressed blob identity + metadata, per the plan's "Blobs (R2)"
// section: "images/video/PDFs are content-addressed `blob_<sha256>` objects
// in an R2 bucket ... CRDT docs and the graph carry only the reference +
// metadata (mime, size, dimensions, filename)".

import CryptoKit
import Foundation

/// The content-addressed identity of a blob: `blob_<sha256-hex>`.
///
/// Deliberately mirrors `PageID`'s shape (a prefixed, hex-digest string) —
/// both are content- or concept-addressed identities meant to be safe to
/// pass across the wire and use as R2 object keys / dictionary keys
/// interchangeably.
public struct BlobID: RawRepresentable, Codable, Hashable, Sendable, Identifiable,
  CustomStringConvertible
{
  public let rawValue: String
  public var id: String { rawValue }
  public var description: String { rawValue }

  public init(rawValue: String) {
    self.rawValue = rawValue
  }

  /// Derives the blob's identity from its bytes. Full SHA-256 (unlike
  /// `PageID`'s truncated digest) — blob identity must be collision-safe
  /// for content-addressed dedup, where `PageID`'s digest only needs
  /// stable-not-random within one vault's page count.
  public init(contentsOf data: Data) {
    let digest = SHA256.hash(data: data)
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    self.init(rawValue: "blob_\(hex)")
  }
}

/// Metadata the graph carries alongside a `BlobID` — never the bytes
/// themselves (plan: "bytes never in CRDT docs").
public struct BlobMetadata: Codable, Hashable, Sendable {
  public var mimeType: String
  public var byteCount: Int
  public var filename: String?
  /// Pixel dimensions, for image/video blobs.
  public var width: Int?
  public var height: Int?

  public init(
    mimeType: String,
    byteCount: Int,
    filename: String? = nil,
    width: Int? = nil,
    height: Int? = nil
  ) {
    self.mimeType = mimeType
    self.byteCount = byteCount
    self.filename = filename
    self.width = width
    self.height = height
  }
}

/// The result of a successful upload — what a caller stores in the graph
/// (as an attachment mark/fact) instead of the bytes.
public struct BlobReference: Codable, Hashable, Sendable, Identifiable {
  public var id: BlobID
  public var metadata: BlobMetadata

  public init(id: BlobID, metadata: BlobMetadata) {
    self.id = id
    self.metadata = metadata
  }
}
