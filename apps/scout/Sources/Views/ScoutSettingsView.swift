import SwiftUI

struct ScoutSettingsView: View {
  @Bindable var grantStore: AccessGrantStore

  var body: some View {
    Form {
      Section("Granted Locations") {
        if grantStore.orderedGrants.isEmpty {
          ContentUnavailableView("No Locations", systemImage: "folder.badge.questionmark")
        } else {
          List {
            ForEach(grantStore.orderedGrants) { grant in
              HStack {
                Image(systemName: "folder.fill").foregroundStyle(Color.accentColor)
                VStack(alignment: .leading) {
                  Text(grant.displayName)
                  Text(grant.lastKnownPath).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Button("Remove", role: .destructive) { try? grantStore.remove(grant) }
              }
            }
            .onMove { source, destination in try? grantStore.move(from: source, to: destination) }
          }
          .frame(minHeight: 180)
        }
        HStack {
          Button("Add Location…") { Task { _ = try? await grantStore.addLocation() } }
          Spacer()
          Text("Scout never requests Full Disk Access.").font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .formStyle(.grouped)
    .padding()
  }
}
