import EnchiridionCore
import SwiftUI
@preconcurrency import UserNotifications

public struct MeetingTranscriptionSettingsSection: View {
  @State private var settings: MeetingTranscriptionSettings
  @State private var notificationStatus = ""

  public init(settings: MeetingTranscriptionSettings = .init()) {
    _settings = State(initialValue: settings)
  }

  public var body: some View {
    Section("Meeting Transcription") {
      Toggle("Prompt when an event starts", isOn: Binding(
        get: { settings.promptsEnabled },
        set: { enabled in
          settings.promptsEnabled = enabled
          if enabled { requestNotificationPermission() }
          else { MeetingTranscriptionRuntime.shared.reconcileCurrent() }
        }
      ))
      Picker("Transcription", selection: $settings.route) {
        ForEach(MeetingTranscriptionRoute.allCases) { route in Text(route.title).tag(route) }
      }
      Text(settings.route == .onDevice
        ? "Audio is transcribed on this device. Meeting audio is not retained."
        : "Cloud transcription is used when configured. Meeting audio is not retained.")
        .font(.caption)
        .foregroundStyle(.secondary)
      if !notificationStatus.isEmpty {
        Text(notificationStatus)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .task { await refreshNotificationStatus() }
  }

  private func requestNotificationPermission() {
    Task {
      let center = UNUserNotificationCenter.current()
      let granted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
      notificationStatus = granted ? "Meeting prompts are allowed." : "Meeting prompts are off in system notification settings."
      if granted { MeetingTranscriptionRuntime.shared.reconcileCurrent() }
    }
  }

  private func refreshNotificationStatus() async {
    let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
    switch notificationSettings.authorizationStatus {
    case .denied: notificationStatus = "Meeting prompts are off in system notification settings."
    case .authorized, .provisional, .ephemeral: notificationStatus = "Meeting prompts are allowed."
    default: notificationStatus = self.settings.promptsEnabled ? "Enable this setting to allow meeting prompts." : ""
    }
  }
}
