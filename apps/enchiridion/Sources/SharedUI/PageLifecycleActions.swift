import EnchiridionCore
import SwiftUI

struct PageLifecycleMenuActions: View {
  let store: LibraryStore
  let page: PageSnapshot
  var showsPinAction = true
  let requestPermanentDeletion: (PageSnapshot) -> Void

  var body: some View {
    if page.deletedAt == nil {
      if showsPinAction {
        Button {
          store.togglePinned(pageID: page.id)
        } label: {
          Label(
            page.isPinned ? "Unpin" : "Pin",
            systemImage: page.isPinned ? "pin.slash" : "pin"
          )
        }
        .accessibilityHint(
          page.isPinned ? "Removes this page from Pinned." : "Adds this page to Pinned.")
        Divider()
      }
      Button(role: .destructive) {
        store.moveToTrash(pageID: page.id)
      } label: {
        Label("Move to Trash", systemImage: "trash")
      }
      .accessibilityHint("Moves this page to Trash, where it can be restored.")
    } else {
      Button {
        store.restore(pageID: page.id)
      } label: {
        Label("Restore", systemImage: "arrow.uturn.backward")
      }
      .accessibilityHint("Returns this page to the library.")
      Divider()
      Button(role: .destructive) {
        requestPermanentDeletion(page)
      } label: {
        Label("Delete Permanently", systemImage: "trash.slash")
      }
      .accessibilityHint("Opens a confirmation before permanently deleting this page.")
    }
  }
}

private struct PermanentPageDeletionConfirmation: ViewModifier {
  @Binding var page: PageSnapshot?
  let delete: (PageID) -> Void

  func body(content: Content) -> some View {
    content.confirmationDialog(
      confirmationTitle,
      isPresented: isPresented,
      titleVisibility: .visible,
      presenting: page
    ) { page in
      Button("Delete Permanently", role: .destructive) {
        delete(page.id)
        self.page = nil
      }
      Button("Cancel", role: .cancel) {
        self.page = nil
      }
    } message: { page in
      Text("\(page.displayTitle) and its data will be permanently deleted. This cannot be undone.")
    }
  }

  private var confirmationTitle: String {
    guard let page else { return "Delete Permanently?" }
    return "Delete \u{201c}\(page.displayTitle)\u{201d} Permanently?"
  }

  private var isPresented: Binding<Bool> {
    Binding(
      get: { page != nil },
      set: { isPresented in
        if !isPresented { page = nil }
      }
    )
  }
}

extension View {
  func confirmsPermanentPageDeletion(
    page: Binding<PageSnapshot?>,
    delete: @escaping (PageID) -> Void
  ) -> some View {
    modifier(PermanentPageDeletionConfirmation(page: page, delete: delete))
  }
}
