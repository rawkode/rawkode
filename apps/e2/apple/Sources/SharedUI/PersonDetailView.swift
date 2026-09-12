import ApsidesCore
import SwiftUI

struct PersonDetailView: View {
    let person: ContextPerson
    @AppStorage("apsidesTheme", store: ApsidesPreferences.store) private var theme: ApsidesTheme = .dawn

    private var emails: [String] {
        Array(Set(person.emails.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty })).sorted()
    }

    var body: some View {
        List {
            if emails.isEmpty {
                ContentUnavailableView("No contact details", systemImage: "person.crop.circle",
                    description: Text("This person has no email address in your connected directory."))
                    .listRowBackground(theme.canvas)
            } else {
                Section("Email") {
                    ForEach(emails, id: \.self) { email in
                        if let destination = emailURL(email) {
                            Link(destination: destination) {
                                Label(email, systemImage: "envelope")
                            }
                            .accessibilityLabel("Email \(person.name) at \(email)")
                            .listRowBackground(theme.canvas)
                        } else {
                            Text(email).textSelection(.enabled).listRowBackground(theme.canvas)
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.canvas)
        .foregroundStyle(theme.ink)
        .tint(theme.accent)
        .navigationTitle(person.name)
    }

    private func emailURL(_ email: String) -> URL? {
        guard email.contains("@"), !email.contains(where: { $0.isWhitespace }) else { return nil }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = email
        return components.url
    }
}
