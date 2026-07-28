import Contacts
import ContactsUI
import EnchiridionCore
import SwiftUI

struct DeviceContactPickerButton: View {
  let page: PageSnapshot
  let store: LibraryStore
  let hasExistingLink: Bool

  @State private var errorMessage: String?
  #if os(iOS)
  @State private var showsPicker = false
  #endif

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      #if os(macOS)
      MacContactPickerButton(title: buttonTitle, selectContact: select)
        .fixedSize()
      #else
      Button(buttonTitle, systemImage: "person.crop.circle.badge.checkmark") {
        showsPicker = true
      }
      .sheet(isPresented: $showsPicker) {
        IOSContactPicker(selectContact: select)
          .ignoresSafeArea()
      }
      #endif

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var buttonTitle: String {
    hasExistingLink ? "Link Different Contact" : "Link Device Contact"
  }

  private var personEmails: Set<String> {
    Set(page.objectMetadata.properties.compactMap { key, values -> [String]? in
      guard key.supertagID == BuiltInSupertags.person,
        key.fieldID.rawValue == "email"
      else { return nil }
      return values.compactMap { value in
        guard case .email(let email) = value else { return nil }
        return DeviceContactRecord.normalizedEmail(email)
      }
    }.flatMap { $0 })
  }

  private func select(_ contact: CNContact) {
    let record = DeviceContactsResolver.record(from: contact)
    guard let matchedEmail = record.normalizedEmails.first(where: personEmails.contains) else {
      errorMessage = "Choose a contact containing one of this Person's exact email addresses."
      return
    }
    errorMessage = nil
    Task {
      await store.saveContactLink(record, for: page.id, matchedEmail: matchedEmail)
    }
  }
}

#if os(iOS)
private struct IOSContactPicker: UIViewControllerRepresentable {
  let selectContact: (CNContact) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

  func makeUIViewController(context: Context) -> CNContactPickerViewController {
    let picker = CNContactPickerViewController()
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: CNContactPickerViewController, context: Context) {}

  final class Coordinator: NSObject, CNContactPickerDelegate {
    let parent: IOSContactPicker

    init(parent: IOSContactPicker) { self.parent = parent }

    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
      parent.selectContact(contact)
      parent.dismiss()
    }

    func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
      parent.dismiss()
    }
  }
}
#else
private struct MacContactPickerButton: NSViewRepresentable {
  let title: String
  let selectContact: (CNContact) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(selectContact: selectContact) }

  func makeNSView(context: Context) -> NSButton {
    let button = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.showPicker(_:)))
    button.bezelStyle = .rounded
    return button
  }

  func updateNSView(_ button: NSButton, context: Context) {
    button.title = title
    context.coordinator.selectContact = selectContact
  }

  final class Coordinator: NSObject, CNContactPickerDelegate {
    var selectContact: (CNContact) -> Void
    private var picker: CNContactPicker?

    init(selectContact: @escaping (CNContact) -> Void) {
      self.selectContact = selectContact
    }

    @MainActor @objc func showPicker(_ sender: NSButton) {
      let picker = CNContactPicker()
      picker.delegate = self
      picker.displayedKeys = []
      self.picker = picker
      picker.showRelative(to: sender.bounds, of: sender, preferredEdge: .maxY)
    }

    func contactPicker(_ picker: CNContactPicker, didSelect contact: CNContact) {
      selectContact(contact)
    }

    func contactPickerDidClose(_ picker: CNContactPicker) {
      self.picker = nil
    }
  }
}
#endif
