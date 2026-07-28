import SwiftUI

struct EmptyLibraryView: View {
  let title: String
  let action: () -> Void

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: "book.closed")
    } description: {
      Text("Create a page to begin building your library.")
    } actions: {
      Button("New Page", action: action)
        .buttonStyle(.borderedProminent)
    }
  }
}
