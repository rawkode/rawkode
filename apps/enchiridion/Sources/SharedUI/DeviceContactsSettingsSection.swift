import Contacts
import EnchiridionCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import ContactsUI
import UIKit
#endif

struct DeviceContactsSettingsSection: View {
  let store: LibraryStore
  let resolver: DeviceContactsResolver

  @State private var status: DeviceContactsAuthorizationStatus
  @State private var isRefreshing = false
  @State private var errorMessage: String?
  #if os(iOS)
  @State private var showsContactAccessPicker = false
  #endif

  init(store: LibraryStore, resolver: DeviceContactsResolver) {
    self.store = store
    self.resolver = resolver
    _status = State(initialValue: DeviceContactsResolver.authorizationStatus)
  }

  var body: some View {
    Section("Contacts") {
      LabeledContent("Access", value: status.title)
      LabeledContent("Matched people", value: store.contactLinks.count.formatted())

      switch status {
      case .notDetermined:
        Button("Allow Contact Enrichment", systemImage: "person.crop.circle.badge.checkmark") {
          Task { await requestAccess() }
        }
      case .denied, .restricted:
        Button("Open Contact Privacy Settings", systemImage: "gear") {
          openSystemSettings()
        }
      case .limited, .authorized:
        Button {
          Task { await refreshMatches() }
        } label: {
          if isRefreshing {
            HStack(spacing: 8) {
              ProgressView()
              Text("Refreshing Contact Matches")
            }
          } else {
            Label("Refresh Contact Matches", systemImage: "arrow.triangle.2.circlepath")
          }
        }
        .disabled(isRefreshing)

        #if os(iOS)
        if status == .limited {
          Button("Manage Selected Contacts", systemImage: "person.crop.circle.badge.plus") {
            showsContactAccessPicker = true
          }
        }
        #endif
      }

      NavigationLink {
        OtherPeopleView(store: store)
      } label: {
        LabeledContent("Other People", value: store.otherPeople.count.formatted())
      }

      Text("Enchiridion only matches people already found in calendar events, using exact email addresses. Contact details stay on this device and never promote someone automatically.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }
    }
    .task {
      store.configureDeviceContactResolver(resolver)
      status = DeviceContactsResolver.authorizationStatus
      if status.canReadContacts { await refreshMatches() }
    }
    .onReceive(NotificationCenter.default.publisher(for: .CNContactStoreDidChange)) { _ in
      status = DeviceContactsResolver.authorizationStatus
      guard status.canReadContacts else { return }
      Task { await refreshMatches() }
    }
    #if os(iOS)
    .contactAccessPicker(isPresented: $showsContactAccessPicker) { _ in
      status = DeviceContactsResolver.authorizationStatus
      Task { await refreshMatches() }
    }
    #endif
  }

  private func requestAccess() async {
    do {
      _ = try await resolver.requestAccess()
      status = DeviceContactsResolver.authorizationStatus
      errorMessage = nil
      if status.canReadContacts { await refreshMatches() }
    } catch {
      status = DeviceContactsResolver.authorizationStatus
      errorMessage = error.localizedDescription
    }
  }

  private func refreshMatches() async {
    guard status.canReadContacts else { return }
    isRefreshing = true
    await store.refreshContactEnrichments()
    isRefreshing = false
  }

  private func openSystemSettings() {
    #if os(macOS)
    guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts") else { return }
    NSWorkspace.shared.open(url)
    #else
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
    #endif
  }
}
