import SwiftUI

struct ScoutSettingsView: View {
  @Bindable var grantStore: AccessGrantStore
  @Environment(\.scoutTheme) private var theme
  @Environment(\.colorScheme) private var colorScheme
  @AppStorage(ScoutThemeDefinition.preferenceKey) private var themeRawValue = ScoutThemeID.system.rawValue

  private var selectedTheme: ScoutThemeID {
    ScoutThemeID(rawValue: themeRawValue) ?? .system
  }

  private var selectedThemeBinding: Binding<ScoutThemeID> {
    Binding(
      get: { selectedTheme },
      set: { themeRawValue = $0.rawValue }
    )
  }

  private var palette: ScoutThemePalette {
    theme.palette(for: colorScheme)
  }

  var body: some View {
    Form {
      Section("Appearance") {
        Picker("Theme", selection: selectedThemeBinding) {
          ForEach(ScoutThemeID.allCases) { theme in
            Text(theme.displayName).tag(theme)
          }
        }

        ThemePreview(theme: ScoutThemeDefinition.named(selectedTheme))

        Text("Every theme includes light and dark colors and follows the current macOS appearance.")
          .font(.caption)
          .foregroundStyle(palette.secondary)
      }

      Section("Granted Locations") {
        if grantStore.orderedGrants.isEmpty {
          ContentUnavailableView("No Locations", systemImage: "folder.badge.questionmark")
        } else {
          List {
            ForEach(grantStore.orderedGrants) { grant in
              HStack {
                Image(systemName: "folder.fill").foregroundStyle(palette.accent)
                VStack(alignment: .leading) {
                  Text(grant.displayName)
                  Text(grant.needsLocalBookmark ? "Choose this location again on this Mac." : grant.lastKnownPath)
                    .font(.caption).foregroundStyle(palette.secondary).lineLimit(1)
                }
                Spacer()
                if grant.needsLocalBookmark {
                  Button("Reconnect") {
                    Task { _ = try? await grantStore.reconnect(grant) }
                  }
                }
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
          Text("Scout never requests Full Disk Access.").font(.caption).foregroundStyle(palette.secondary)
        }
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(palette.canvas)
    .tint(palette.accent)
    .foregroundStyle(palette.primary)
    .padding()
  }
}

private struct ThemePreview: View {
  let theme: ScoutThemeDefinition

  @Environment(\.colorScheme) private var colorScheme

  private var palette: ScoutThemePalette {
    theme.palette(for: colorScheme)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(theme.id.displayName)
          .font(.callout.weight(.semibold))
        Text(colorScheme == .dark ? "Dark" : "Light")
          .font(.caption)
          .foregroundStyle(palette.secondary)
        Spacer()
        Text(theme.id.subtitle)
          .font(.caption)
          .foregroundStyle(palette.secondary)
          .lineLimit(1)
      }

      HStack(spacing: 5) {
        swatch(palette.canvas)
        swatch(palette.elevated)
        swatch(palette.chrome)
        swatch(palette.selection)
        swatch(palette.accent)
        Spacer()
      }
    }
    .padding(10)
    .background(palette.elevated, in: .rect(cornerRadius: 8))
    .overlay { RoundedRectangle(cornerRadius: 8).stroke(palette.separator) }
    .foregroundStyle(palette.primary)
  }

  private func swatch(_ color: Color) -> some View {
    RoundedRectangle(cornerRadius: 4, style: .continuous)
      .fill(color)
      .frame(width: 28, height: 22)
      .overlay { RoundedRectangle(cornerRadius: 4).stroke(palette.separator.opacity(0.7)) }
      .accessibilityHidden(true)
  }
}
