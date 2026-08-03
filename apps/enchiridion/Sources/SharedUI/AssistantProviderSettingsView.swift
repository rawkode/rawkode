import EnchiridionCore
import SwiftUI

struct AssistantProviderSettingsSection: View {
  let controller: AssistantProviderSettingsController
  let qwenController: QwenProviderSettingsController

  init(
    controller: AssistantProviderSettingsController,
    qwenController: QwenProviderSettingsController = QwenProviderSettingsController()
  ) {
    self.controller = controller
    self.qwenController = qwenController
  }

  var body: some View {
    Section("Assistant") {
      NavigationLink {
        AssistantProviderSettingsView(
          controller: controller,
          qwenController: qwenController
        )
      } label: {
        LabeledContent(
          "Default text provider",
          value: controller.selectedProvider.title
        )
      }
      LabeledContent("OpenAI key", value: controller.credentialState.title)
        .foregroundStyle(.secondary)
      LabeledContent("Default voice provider", value: controller.selectedVoiceProvider.title)
        .foregroundStyle(.secondary)
    }
    .task { await controller.refreshCredentialState() }
  }
}

struct AssistantProviderSettingsView: View {
  let controller: AssistantProviderSettingsController
  let qwenController: QwenProviderSettingsController

  @State private var qwenToken = ""
  @State private var qwenWorkspaceID = ""
  @State private var showsQwenDeleteConfirmation = false

  @Environment(\.openURL) private var openURL
  @State private var candidate = ""
  @State private var showsDeleteConfirmation = false
  @State private var showsTextConsentConfirmation = false
  @State private var showsVoiceConsentConfirmation = false

  init(
    controller: AssistantProviderSettingsController,
    qwenController: QwenProviderSettingsController = QwenProviderSettingsController()
  ) {
    self.controller = controller
    self.qwenController = qwenController
  }

  var body: some View {
    Form {
      providerSection
      openAICredentialSection
      if controller.credentialState == .savedAndVerified {
        textModelSection
        consentSection
      }
      voiceSection
      qwenRealtimeSection
      securitySection
      billingSection
    }
    .formStyle(.grouped)
    .navigationTitle("Assistant Providers")
    .task { await controller.refreshCredentialState() }
    .task {
      await qwenController.refresh()
      qwenWorkspaceID = qwenController.workspaceID ?? ""
    }
    .onDisappear { candidate = "" }
    .confirmationDialog(
      "Delete OpenAI key from this device?",
      isPresented: $showsDeleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("Delete from This Device", role: .destructive) {
        candidate = ""
        Task { _ = await controller.deleteCredential() }
      }
      Button("Keep Key", role: .cancel) {}
    } message: {
      Text(
        "This resets OpenAI provider, consent, and model choices. It does not revoke the key at OpenAI."
      )
    }
    .confirmationDialog(
      "Use OpenAI for Text?",
      isPresented: $showsTextConsentConfirmation,
      titleVisibility: .visible
    ) {
      Button("Use OpenAI for Text") {
        guard
          let modelID = controller.selectedTextModelID
            ?? controller.verifiedTextOptions.first?.id
        else { return }
        _ = controller.authorizeOpenAITextAndSelect(modelID: modelID)
      }
      Button("Keep Apple", role: .cancel) {}
    } message: {
      Text(openAIConsentDisclosure)
    }
    .confirmationDialog(
      OpenAIRealtimeVoiceConsentCopy.title,
      isPresented: $showsVoiceConsentConfirmation,
      titleVisibility: .visible
    ) {
      Button(OpenAIRealtimeVoiceConsentCopy.startActionTitle) {
        let voiceID = controller.selectedRealtimeVoice?.id
          ?? OpenAIRealtimeVoiceCatalog.preferredDefault.id
        guard
          let modelID = controller.selectedRealtimeModelID
            ?? controller.verifiedRealtimeOptions.first?.id
        else { return }
        _ = controller.authorizeOpenAIRealtimeVoiceAndSelect(
          modelID: modelID,
          voiceID: voiceID
        )
      }
      Button(OpenAIRealtimeVoiceConsentCopy.keepAppleActionTitle, role: .cancel) {
        controller.selectVoiceProvider(.appleOnDevice)
      }
    } message: {
      Text(OpenAIRealtimeVoiceConsentCopy.body)
    }
    .confirmationDialog(
      "Delete Qwen token from this device?",
      isPresented: $showsQwenDeleteConfirmation,
      titleVisibility: .visible
    ) {
      Button("Delete from This Device", role: .destructive) {
        qwenToken = ""
        Task {
          if await qwenController.deleteToken() {
            controller.selectVoiceProvider(.appleOnDevice)
          }
        }
      }
      Button("Keep Token", role: .cancel) {}
    } message: {
      Text("This prevents future Qwen Voice sessions. It does not revoke the token in Model Studio.")
    }
  }

  private var qwenRealtimeSection: some View {
    Section("Qwen Audio Realtime") {
      LabeledContent("Status", value: qwenController.isConfigured ? "Saved and verified" : "Not configured")
      TextField("Beijing workspace ID", text: $qwenWorkspaceID)
        .accessibilityHint("The workspace ID is used only to construct the Beijing Qwen Realtime endpoint.")
      SecureField("Paste a Model Studio API key", text: $qwenToken)
        .textContentType(.password)
        .privacySensitive()
      Picker("Tier", selection: Binding(get: { qwenController.model }, set: { qwenController.select(model: $0) })) {
        ForEach(QwenRealtimeModel.allCases) { Text($0.title).tag($0) }
      }
      Picker("Voice", selection: Binding(get: { qwenController.voice }, set: { qwenController.select(voice: $0) })) {
        ForEach(QwenRealtimeVoice.allCases) { Text($0.title).tag($0) }
      }
      Button(qwenController.isValidating ? "Verifying…" : "Verify and Save Qwen Token") {
        let token = qwenToken
        let workspaceID = qwenWorkspaceID
        Task { if await qwenController.verifyAndSave(token: token, workspaceID: workspaceID) { qwenToken = "" } }
      }
      .disabled(qwenController.isValidating || qwenToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      if qwenController.isConfigured {
        Button("Use Qwen Audio Realtime") {
          controller.selectVoiceProvider(.qwenRealtime)
        }
        .disabled(controller.selectedVoiceProvider == .qwenRealtime)
        Button("Delete from This Device", role: .destructive) { showsQwenDeleteConfirmation = true }
          .disabled(qwenController.isValidating)
      }
      if let error = qwenController.error {
        Text(qwenErrorCopy(error)).font(.caption).foregroundStyle(.red)
      }
      Text("Saving a verified Model Studio token is your explicit opt-in to Qwen Audio Realtime and processing in the China (Beijing) region. Enchiridion does not show a separate provider or location consent prompt. Qwen uses only the workspace-specific Beijing endpoint. Native confirmation still applies to mutating or destructive local actions.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func qwenErrorCopy(_ error: QwenWorkspaceValidationError) -> String {
    switch error {
    case .invalidWorkspace: "Enter a valid Qwen Model Studio workspace ID."
    case .rejected: "Qwen rejected this token or workspace."
    case .redirectBlocked: "Qwen verification rejected an unexpected redirect."
    case .timedOut: "Qwen verification timed out. Try again later."
    case .unavailable: "Qwen could not verify this token. Try again later."
    }
  }

  private var providerSection: some View {
    Section("Assistant Routing") {
      LabeledContent("Default text provider", value: controller.selectedProvider.title)

      Button("Use Apple On Device") {
        controller.selectProvider(.appleOnDevice)
      }
      .disabled(controller.selectedProvider == .appleOnDevice)

      Button("Use OpenAI for Text") {
        if controller.hasTextConsent, controller.canSelectOpenAI {
          controller.selectProvider(.openAI)
        } else {
          showsTextConsentConfirmation = true
        }
      }
      .disabled(
        controller.credentialState != .savedAndVerified
          || controller.verifiedTextOptions.isEmpty
      )

      Text(
        "Text chat and voice use separate defaults. CarPlay follows the selected Apple On Device or Qwen voice route; App Intents remain Apple On Device. Apple Private Cloud Compute is not offered because Enchiridion has no verified PCC entitlement or runtime path."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var openAICredentialSection: some View {
    Section("OpenAI API Key") {
      LabeledContent("Status", value: controller.credentialState.title)

      SecureField("Paste a project API key", text: $candidate)
        .textContentType(.password)
        #if os(iOS)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.asciiCapable)
        #endif
        .privacySensitive()
        .accessibilityLabel("OpenAI project API key")
        .accessibilityHint(
          "The saved key is never displayed. Paste a candidate to verify and save it.")

      verificationControls

      if controller.hasSavedCredential {
        Button("Delete from This Device", role: .destructive) {
          showsDeleteConfirmation = true
        }
        .disabled(controller.isValidating)
      }

      if let error = controller.error {
        Label {
          VStack(alignment: .leading, spacing: 4) {
            Text(error.title)
            Text(error.detail)
              .font(.caption)
            if let requestID = error.requestID {
              Text("Request ID: \(requestID)")
                .font(.caption.monospaced())
                .textSelection(.enabled)
            }
          }
        } icon: {
          Image(systemName: "exclamationmark.triangle")
        }
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
      }

      Text(
        "No request is made until you choose Verify. Verification lists model IDs only. It does not send notes, tasks, calendar data, prompts, or audio."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private var verificationControls: some View {
    if controller.retryUntil == nil {
      verificationButton(retrySeconds: nil)
    } else {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let seconds = controller.retrySecondsRemaining(at: context.date)
        VStack(alignment: .leading, spacing: 8) {
          verificationButton(retrySeconds: seconds)
          if let seconds {
            Text("Retry available in \(seconds) seconds")
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)
              .accessibilityLabel("Retry available in \(seconds) seconds")
          }
        }
      }
    }
  }

  private func verificationButton(retrySeconds: Int?) -> some View {
    Button {
      Task {
        if await controller.verifyAndSave(candidate: candidate) { candidate = "" }
      }
    } label: {
      if controller.isValidating {
        HStack(spacing: 8) {
          ProgressView()
          Text("Verifying")
        }
      } else {
        Text(controller.hasSavedCredential ? "Verify & Replace" : "Verify & Save")
      }
    }
    .disabled(
      candidate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || controller.isValidating
        || retrySeconds != nil
    )
    .accessibilityHint(
      "Sends one request to OpenAI's models endpoint, then saves the key only if accepted.")
  }

  private var consentSection: some View {
    Section("OpenAI Text Consent") {
      LabeledContent("Status", value: controller.hasTextConsent ? "Granted" : "Required")
      if controller.hasTextConsent {
        Button("Revoke OpenAI Text Consent", role: .destructive) {
          controller.setTextConsent(false)
        }
      }
      Text(openAIConsentDisclosure)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

    }
  }

  private var textModelSection: some View {
    Section("OpenAI Text Tier") {
      if controller.verifiedTextOptions.isEmpty {
        ContentUnavailableView(
          "No compatible text tier",
          systemImage: "cpu",
          description: Text(
            "The key was accepted, but OpenAI did not list a model in Enchiridion's reviewed catalog. Verify again after an app update or project access change."
          )
        )
      } else {
        Picker("Text tier", selection: modelBinding) {
          Text("Choose a tier").tag(String?.none)
          ForEach(controller.verifiedTextOptions) { model in
            VStack(alignment: .leading) {
              Text(model.title)
              Text(model.detail).font(.caption)
            }
            .tag(Optional(model.id))
          }
        }
        .disabled(!controller.hasTextConsent)
      }

      Text(
        "The models endpoint proves only that this project can see an ID. Enchiridion's versioned catalog defines the text tiers; it does not infer capability or current pricing from the response."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var voiceSection: some View {
    Section("OpenAI Voice") {
      Picker("Default voice provider", selection: voiceProviderBinding) {
        Text(AssistantVoiceProvider.appleOnDevice.title)
          .tag(AssistantVoiceProvider.appleOnDevice)
        Text(AssistantVoiceProvider.openAIRealtime.title)
          .tag(AssistantVoiceProvider.openAIRealtime)
        Text(AssistantVoiceProvider.qwenRealtime.title)
          .tag(AssistantVoiceProvider.qwenRealtime)
      }

      if controller.credentialState == .savedAndVerified {
        if controller.verifiedRealtimeOptions.isEmpty {
          ContentUnavailableView(
            "No verified Realtime model",
            systemImage: "waveform.slash",
            description: Text(
              "This key did not list a Realtime model in Enchiridion's reviewed catalog."
            )
          )
        } else {
          Picker("Verified Realtime model", selection: realtimeModelBinding) {
            Text("Choose a model").tag(String?.none)
            ForEach(controller.verifiedRealtimeOptions) { model in
              Text(model.title).tag(Optional(model.id))
            }
          }
        }

        Picker("Official OpenAI voice", selection: realtimeVoiceBinding) {
          ForEach(OpenAIRealtimeVoiceCatalog.reviewed) { voice in
            Text(voice.title).tag(Optional(voice.id))
          }
        }

        LabeledContent(
          "Voice consent",
          value: controller.hasVoiceConsent ? "Current" : "Required"
        )

        if controller.hasVoiceConsent {
          Button("Revoke OpenAI Voice Consent", role: .destructive) {
            controller.setVoiceConsent(false)
            controller.selectVoiceProvider(.appleOnDevice)
          }
        } else {
          Button("Review OpenAI Voice Consent") {
            showsVoiceConsentConfirmation = true
          }
          .disabled(
            controller.selectedRealtimeModelID == nil
              || controller.selectedRealtimeVoice == nil
          )
        }
      }

      LabeledContent(
        "Connection",
        value: "Direct device BYOK"
      )
        .foregroundStyle(.secondary)
      Text(
        "Your saved Platform key remains in this device's Keychain. Native code sends it only in the Authorization header to the pinned OpenAI endpoint after you start an audio-only session. Voice sends audio and transcripts only; notes, tasks, calendars, and local tools stay on-device. API use is billed separately from ChatGPT. Apple On Device voice remains available."
      )
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)

      Text(OpenAIRealtimeVoiceConsentCopy.body)
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var securitySection: some View {
    Section("Device Security") {
      Text(deviceStorageCopy)
      Text(
        "A compromised or unlocked device may expose the key. OpenAI recommends keeping standard API keys on a backend instead of in mobile or client apps. Enchiridion's runtime BYOK mode knowingly accepts that additional risk."
      )
      Text("Deleting here removes the local Keychain item but does not revoke the key at OpenAI.")
      Link(
        "Manage and revoke API keys",
        destination: URL(string: "https://platform.openai.com/api-keys")!)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  private var billingSection: some View {
    Section("Billing and Limits") {
      Text(
        "OpenAI API use is billed to the project that owns this key. Use a dedicated project, restrict the key, set spend alerts or limits, and expect rate limits."
      )
      Link(
        "Review project limits",
        destination: URL(string: "https://platform.openai.com/settings/organization/limits")!)
      Link("Review API usage", destination: URL(string: "https://platform.openai.com/usage")!)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  private var modelBinding: Binding<String?> {
    Binding(
      get: { controller.selectedTextModelID },
      set: { controller.selectTextModel(id: $0) }
    )
  }

  private var voiceProviderBinding: Binding<AssistantVoiceProvider> {
    Binding(
      get: { controller.selectedVoiceProvider },
      set: { provider in
        switch provider {
        case .appleOnDevice:
          controller.selectVoiceProvider(.appleOnDevice)
        case .openAIRealtime:
          if controller.hasVoiceConsent, controller.canSelectOpenAIRealtimeVoice {
            controller.selectVoiceProvider(.openAIRealtime)
          } else {
            showsVoiceConsentConfirmation = true
          }
        case .qwenRealtime:
          controller.selectVoiceProvider(
            qwenController.isConfigured ? .qwenRealtime : .appleOnDevice
          )
        }
      }
    )
  }

  private var realtimeModelBinding: Binding<String?> {
    Binding(
      get: { controller.selectedRealtimeModelID },
      set: { controller.selectRealtimeModel(id: $0) }
    )
  }

  private var realtimeVoiceBinding: Binding<String?> {
    Binding(
      get: { controller.selectedRealtimeVoice?.id },
      set: { controller.selectRealtimeVoice(id: $0) }
    )
  }

  private var deviceStorageCopy: String {
    #if os(iOS)
      "The key stays in this iPhone's passcode-protected Keychain. It does not sync or migrate to another device, and saving is refused without a passcode. Protected Keychain material may still be present in a same-device backup."
    #else
      "The key stays in this Mac's device-only Keychain and is available only while the Mac is unlocked. It does not sync or migrate to another device. Protected Keychain material may still be present in a same-device backup."
    #endif
  }

  private var openAIConsentDisclosure: String {
    """
    Enchiridion sends submitted text and bounded OpenAI text-chat history directly from this device to OpenAI. The default text route sends no notes, tasks, calendar events, local search results, or local-tool outputs. Your API key stays in this device's Keychain. Requests use store:false, though OpenAI may retain abuse-monitoring data for up to 30 days. API usage is billed separately from ChatGPT. Text consent does not authorize microphone access or OpenAI Voice; voice requires separate explicit consent. OpenAI is not used by CarPlay or App Intents.
    """
  }
}
