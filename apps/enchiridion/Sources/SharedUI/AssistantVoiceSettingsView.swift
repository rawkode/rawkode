import EnchiridionCore
import SwiftUI

struct AssistantVoiceSettingsSection: View {
  let preferences: AssistantVoicePreferences

  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Section("Assistant Voice") {
      NavigationLink {
        AssistantVoiceSettingsView(preferences: preferences)
      } label: {
        LabeledContent("Voice", value: preferences.preferenceName)
      }
      AssistantVoiceCurrentSummary(preferences: preferences)
      if preferences.isStoredSelectionUnavailable {
        Label(
          "Your selected voice is unavailable. Enchiridion is using Automatic without changing your selection.",
          systemImage: "arrow.trianglehead.2.clockwise.rotate.90"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear { preferences.refresh() }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      preferences.refresh()
    }
  }
}

struct AssistantVoiceSettingsView: View {
  let preferences: AssistantVoicePreferences

  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    List {
      Section {
        voiceButton(
          title: "Automatic",
          subtitle: "Uses the best installed voice for your language.",
          preference: .automatic,
          isSelected: preferences.preference == .automatic
        )
      }

      if preferences.isStoredSelectionUnavailable {
        Section("Selected Voice") {
          Label(
            "The selected voice is not installed right now. Automatic is being used until that exact voice returns.",
            systemImage: "exclamationmark.circle"
          )
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }

      ForEach(groupedVoices, id: \.language) { group in
        Section(group.localizedName) {
          ForEach(group.voices) { voice in
            voiceButton(
              title: voice.name,
              subtitle: voiceDescription(voice),
              preference: .specific(identifier: voice.identifier),
              isSelected: preferences.preference
                == .specific(identifier: voice.identifier)
            )
          }
        }
      }

      Section("Currently using") {
        AssistantVoiceCurrentSummary(preferences: preferences)
      }

      if let voice = preferences.effectiveVoice,
        voice.quality == .default,
        !voice.isPersonalVoice
      {
        Section {
          Label {
            VStack(alignment: .leading, spacing: 6) {
              Text("Enhanced or Premium voices may sound more natural.")
              Text(voiceDownloadGuidance)
                .font(.caption)
              Text("Apple downloads voices. Enchiridion refreshes after the download finishes.")
                .font(.caption)
            }
            .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "waveform.badge.exclamationmark")
          }
          .foregroundStyle(.secondary)
        }
      }

      Section("Preview") {
        Text(AssistantVoicePreferences.previewPhrase)
          .fixedSize(horizontal: false, vertical: true)
        Button {
          preferences.togglePreview()
        } label: {
          Label(
            preferences.isPreviewing ? "Stop Preview" : "Preview Voice",
            systemImage: preferences.isPreviewing ? "stop.fill" : "speaker.wave.2.fill"
          )
          .frame(minHeight: 44)
        }
        .disabled(preferences.effectiveVoice == nil)
      }
    }
    .navigationTitle("Assistant Voice")
    .onAppear { preferences.refresh() }
    .onDisappear { preferences.stopPreview() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        preferences.refresh()
      } else {
        preferences.stopPreview()
      }
    }
  }

  private func voiceButton(
    title: String,
    subtitle: String,
    preference: AssistantVoicePreference,
    isSelected: Bool
  ) -> some View {
    Button {
      preferences.select(preference)
    } label: {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .foregroundStyle(.primary)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        if isSelected {
          Image(systemName: "checkmark")
            .fontWeight(.semibold)
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
        }
      }
      .contentShape(Rectangle())
      .frame(minHeight: 44)
    }
    .buttonStyle(.plain)
    .accessibilityValue(isSelected ? "Selected" : "")
  }

  private func voiceDescription(_ voice: AssistantInstalledVoice) -> String {
    var values = [voice.localizedLocaleName, voice.qualityName]
    if voice.isPersonalVoice { values.append("Personal Voice") }
    return values.joined(separator: " · ")
  }

  private var groupedVoices:
    [(language: String, localizedName: String, voices: [AssistantInstalledVoice])]
  {
    Dictionary(grouping: preferences.availableVoices, by: \.language)
      .map { language, voices in
        (
          language: language,
          localizedName: voices.first?.localizedLocaleName ?? language,
          voices: voices
        )
      }
      .sorted {
        let order = $0.localizedName.localizedStandardCompare($1.localizedName)
        if order != .orderedSame { return order == .orderedAscending }
        return $0.language < $1.language
      }
  }

  private var voiceDownloadGuidance: String {
    #if os(iOS)
      "Open Settings > Accessibility > Read & Speak > Voices."
    #elseif os(macOS)
      "Open System Settings > Accessibility > Read & Speak."
    #else
      ""
    #endif
  }
}

private struct AssistantVoiceCurrentSummary: View {
  let preferences: AssistantVoicePreferences

  var body: some View {
    LabeledContent("Currently using") {
      if let voice = preferences.effectiveVoice {
        VStack(alignment: .trailing, spacing: 2) {
          Text(voice.name)
          Text(voice.localizedLocaleName)
            .foregroundStyle(.secondary)
          Text(voice.qualityName + (voice.isPersonalVoice ? " · Personal Voice" : ""))
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
          "Currently using \(voice.name), \(voice.localizedLocaleName), \(voice.qualityName)"
            + (voice.isPersonalVoice ? ", Personal Voice" : "")
        )
      } else {
        Text("No compatible installed voice")
          .foregroundStyle(.secondary)
      }
    }
  }
}
