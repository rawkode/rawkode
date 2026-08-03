import Foundation

/// The persistence adapter is intentionally injected. P1 supplies the concrete
/// `EditorPersistenceSession` bridge: it must flush, remap the selection in the
/// durable document, and resolve it again before returning a target.
@available(iOS 26.0, macOS 26.0, *)
enum PageReferenceOpenAction {
  typealias Reference = PageReferenceSelectionResolver.ResolvedReference

  /// Opens only if the post-flush, re-resolved semantic destination remains
  /// exactly the captured destination. Labels and text offsets may change as
  /// long as the same live page in the same vault remains selected.
  @discardableResult
  static func perform(
    captured reference: Reference,
    flushAndRevalidate: @escaping @Sendable (Reference) async -> Reference?,
    open: @escaping @Sendable (Reference) async -> Void
  ) async -> Bool {
    guard let revalidated = await flushAndRevalidate(reference),
      revalidated.sourceVaultID == reference.sourceVaultID,
      revalidated.sourcePageID == reference.sourcePageID,
      revalidated.destination.vaultID == reference.destination.vaultID,
      revalidated.destination.pageID == reference.destination.pageID,
      !revalidated.destination.isDeleted
    else { return false }

    await open(revalidated)
    return true
  }
}

