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
          "Your selected voice is unavailable right now. Best Available is being used until it becomes available again.",
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
          title: "Best Available",
          subtitle: "Prefers Premium, then Enhanced, then Basic for your language.",
          preference: .automatic,
          isSelected: preferences.preference == .automatic
        )
      }

      if preferences.isStoredSelectionUnavailable {
        Section("Selected Voice") {
          Label(
            "Your selected voice is unavailable right now. Best Available is being used until it becomes available again.",
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
        if preferences.preference == .automatic {
          AssistantVoiceAutomaticQualitySummary(preferences: preferences)
        }
      }

      if preferences.preference == .automatic,
        let voice = preferences.effectiveVoice,
        voice.quality != .premium,
        !voice.isPersonalVoice
      {
        Section {
          Label {
            VStack(alignment: .leading, spacing: 6) {
              Text(fallbackGuidance(for: voice))
              Text(voiceDownloadGuidance)
                .font(.caption)
              Text(
                "Apple manages downloaded voices. Enchiridion refreshes automatically when the installed voices change."
              )
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
        .disabled(
          preferences.effectiveVoice == nil || preferences.isConversationSpeechActive
        )
        .accessibilityHint(previewAccessibilityHint)
        if preferences.isConversationSpeechActive {
          Text("Preview is unavailable while the assistant is speaking.")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
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
    var values = [voice.qualityName, voice.localizedLocaleName]
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
        let lhsIsPreferredLocale = preferences.isPreferredLocale($0.language)
        let rhsIsPreferredLocale = preferences.isPreferredLocale($1.language)
        if lhsIsPreferredLocale != rhsIsPreferredLocale {
          return lhsIsPreferredLocale
        }
        let lhsIsPreferred = preferences.isPreferredLanguage($0.language)
        let rhsIsPreferred = preferences.isPreferredLanguage($1.language)
        if lhsIsPreferred != rhsIsPreferred {
          return lhsIsPreferred
        }
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

  private var previewAccessibilityHint: String {
    if preferences.isConversationSpeechActive {
      return "Wait for the current assistant response to finish."
    }
    return preferences.isPreviewing
      ? "Stops the current voice preview."
      : "Speaks a short sample using the selected voice."
  }

  private func fallbackGuidance(for voice: AssistantInstalledVoice) -> String {
    switch voice.quality {
    case .premium:
      ""
    case .enhanced:
      "No Premium voice is installed for \(voice.localizedLocaleName). Enchiridion is using Enhanced."
    case .default:
      "No Premium or Enhanced voice is installed for \(voice.localizedLocaleName). Enchiridion is using Basic."
    }
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

private struct AssistantVoiceAutomaticQualitySummary: View {
  let preferences: AssistantVoicePreferences

  var body: some View {
    if let voice = preferences.effectiveVoice {
      Label(message(for: voice), systemImage: icon(for: voice))
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(message(for: voice))
    }
  }

  private func message(for voice: AssistantInstalledVoice) -> String {
    switch voice.quality {
    case .premium:
      "Premium is installed and selected."
    case .enhanced:
      "Premium is not installed for \(voice.localizedLocaleName). Using Enhanced."
    case .default:
      "Premium and Enhanced are not installed for \(voice.localizedLocaleName). Using Basic."
    }
  }

  private func icon(for voice: AssistantInstalledVoice) -> String {
    voice.quality == .premium ? "checkmark.circle" : "arrow.down.circle"
  }
}
