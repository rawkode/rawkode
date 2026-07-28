import Contacts
import EnchiridionCore
import SwiftUI

extension View {
  func managesDeviceContacts(
    store: LibraryStore,
    resolver: DeviceContactsResolver
  ) -> some View {
    modifier(DeviceContactsLifecycleModifier(store: store, resolver: resolver))
  }
}

private struct DeviceContactsLifecycleModifier: ViewModifier {
  let store: LibraryStore
  let resolver: DeviceContactsResolver

  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content
      .task { await refreshAuthorization() }
      .onChange(of: scenePhase) { _, phase in
        guard phase == .active else { return }
        Task { await refreshAuthorization() }
      }
      .onReceive(NotificationCenter.default.publisher(for: .CNContactStoreDidChange)) { _ in
        Task { await refreshAuthorization() }
      }
  }

  private func refreshAuthorization() async {
    store.configureDeviceContactResolver(resolver)
    await store.deviceContactsAuthorizationDidChange(
      DeviceContactsResolver.authorizationStatus.coreValue
    )
  }
}
