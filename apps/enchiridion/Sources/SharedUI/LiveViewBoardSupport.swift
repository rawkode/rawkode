import EnchiridionCore

/// Keeps the compact board's selection attached to a column identity, never a page index.
enum LiveViewBoardColumnSelection {
  static func reconciled(
    currentSelection: String?,
    previousOptionIDs: [String],
    optionIDs: [String]
  ) -> String? {
    guard !optionIDs.isEmpty else { return nil }
    guard let currentSelection else { return optionIDs.first }
    if optionIDs.contains(currentSelection) { return currentSelection }

    guard let previousIndex = previousOptionIDs.firstIndex(of: currentSelection) else {
      return optionIDs.first
    }

    return optionIDs.min { lhs, rhs in
      let lhsDistance = abs((previousOptionIDs.firstIndex(of: lhs) ?? Int.max) - previousIndex)
      let rhsDistance = abs((previousOptionIDs.firstIndex(of: rhs) ?? Int.max) - previousIndex)
      return lhsDistance < rhsDistance
    } ?? optionIDs.first
  }
}

struct LiveViewBoardPropertyMutation: Equatable {
  let pageID: PageID
  let supertagID: SupertagID
  let fieldID: SupertagFieldID
  let values: [SupertagValue]
}

/// Validates every route into a board move before the store is asked to mutate a page.
enum LiveViewBoardMove {
  static func mutation(
    item: LiveQueryItem,
    source: LiveQuerySource,
    groupFieldID: SupertagFieldID?,
    destinationID: String,
    validDestinationIDs: Set<String>
  ) -> LiveViewBoardPropertyMutation? {
    guard
      case .page(let page) = item,
      case .supertag(let supertagID) = source,
      let groupFieldID,
      validDestinationIDs.contains(destinationID)
    else { return nil }

    return LiveViewBoardPropertyMutation(
      pageID: page.id,
      supertagID: supertagID,
      fieldID: groupFieldID,
      values: destinationID == "__unset" ? [] : [.select(destinationID)]
    )
  }
}
