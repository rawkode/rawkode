// CanvasBlobStore.swift
// EnchiridionCanvas
//
// Wires `CanvasDocument` (CanvasDocument.swift) to `EnchiridionBlobs`'
// content-addressed blob cache — P7 "native drawing canvas" task's "canvas
// content stored as a content-addressed blob via the existing
// `EnchiridionBlobs`/R2 path (same scheme as images)" requirement.
//
// Read `EnchiridionBlobs/BlobCache.swift` and its README in full before
// touching this file (task brief) — the mechanism this wraps: `BlobCache
// .uploadBlob(data:metadata:)` content-addresses the bytes client-side
// (`BlobID(contentsOf:)`) before a `PUT /blobs/<id>` to the vault worker,
// and returns a `BlobReference` (id + metadata) that the CALLER stores in
// the graph — never the bytes. This file adds no new upload/download
// mechanism of its own; it only knows how to turn a `CanvasDocument` into
// the `Data`/`BlobMetadata` that mechanism expects, and back.

import EnchiridionBlobs
import Foundation

public enum CanvasBlobStoreError: Error, Sendable, Equatable, LocalizedError {
  case serializationFailed(String)
  case deserializationFailed(String)

  public var errorDescription: String? {
    switch self {
    case .serializationFailed(let message): "Failed to encode canvas content: \(message)"
    case .deserializationFailed(let message): "Failed to decode canvas content: \(message)"
    }
  }
}

/// Upload/download a `CanvasDocument` as a content-addressed blob.
///
/// A plain `enum` namespace (not a type wrapping a `BlobCache`) —
/// `BlobCache` is already the actor owning the real cache/network state
/// (see its header: "an actor because concurrent upload/download calls
/// ... serialize safely"); this file has no state of its own to protect,
/// only a `CanvasDocument <-> Data` translation either side of a call the
/// caller already has a `BlobCache` instance to make.
public enum CanvasBlobStore {
  /// The MIME type canvas content blobs are uploaded/stored under — a
  /// vendor content type (not `application/json`) so a future consumer
  /// (a blob browser, a thumbnail generator) can recognize "this blob is
  /// canvas content" from `BlobMetadata.mimeType` alone, without
  /// downloading and sniffing the bytes.
  public static let mimeType = "application/vnd.enchiridion.canvas+json"

  /// Serializes `document` (`CanvasDocumentCoding.encode`) and uploads it
  /// through `cache`, returning the `BlobReference` to store in the graph
  /// (via `CanvasEmbed.embed`/`embedNewCanvasPage` — CanvasPageAttachment.swift).
  public static func upload(_ document: CanvasDocument, using cache: BlobCache) async throws -> BlobReference {
    let data: Data
    do {
      data = try CanvasDocumentCoding.encode(document)
    } catch {
      throw CanvasBlobStoreError.serializationFailed(String(describing: error))
    }
    let metadata = BlobMetadata(
      mimeType: mimeType,
      byteCount: data.count,
      filename: nil,
      width: Int(document.canvasSize.width.rounded()),
      height: Int(document.canvasSize.height.rounded())
    )
    return try await cache.uploadBlob(data: data, metadata: metadata)
  }

  /// Downloads and decodes the canvas content at `id` through `cache`.
  public static func download(id: BlobID, using cache: BlobCache) async throws -> CanvasDocument {
    let data = try await cache.downloadBlob(id: id)
    do {
      return try CanvasDocumentCoding.decode(data)
    } catch {
      throw CanvasBlobStoreError.deserializationFailed(String(describing: error))
    }
  }
}
