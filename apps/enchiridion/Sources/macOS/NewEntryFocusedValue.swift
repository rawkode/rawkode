import SwiftUI

struct NewPageActionKey: FocusedValueKey {
  typealias Value = () -> Void
}

extension FocusedValues {
  var newPageAction: (() -> Void)? {
    get { self[NewPageActionKey.self] }
    set { self[NewPageActionKey.self] = newValue }
  }
}
