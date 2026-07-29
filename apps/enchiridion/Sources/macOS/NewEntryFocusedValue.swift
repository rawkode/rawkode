import EnchiridionCore
import SwiftUI

struct NewPageActionKey: FocusedValueKey {
  typealias Value = () -> Void
}

struct NewTaskActionKey: FocusedValueKey {
  typealias Value = () -> Void
}

struct OpenTaskListActionKey: FocusedValueKey {
  typealias Value = (TaskSmartList) -> Void
}

extension FocusedValues {
  var newPageAction: (() -> Void)? {
    get { self[NewPageActionKey.self] }
    set { self[NewPageActionKey.self] = newValue }
  }

  var newTaskAction: (() -> Void)? {
    get { self[NewTaskActionKey.self] }
    set { self[NewTaskActionKey.self] = newValue }
  }

  var openTaskListAction: ((TaskSmartList) -> Void)? {
    get { self[OpenTaskListActionKey.self] }
    set { self[OpenTaskListActionKey.self] = newValue }
  }
}
