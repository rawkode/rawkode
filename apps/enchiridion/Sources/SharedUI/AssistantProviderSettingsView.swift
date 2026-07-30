import EnchiridionCore
import SwiftUI

struct AssistantProviderSettingsSection: View {
  let controller: AssistantProviderSettingsController

  var body: some View {
    Section("Assistant") {
      NavigationLink {
        AssistantProviderSettingsView(controller: controller)
      } label: {
        LabeledContent(
          "Default text provider",
          value: controller.selectedProvider.title
        )
      }
      LabeledContent("OpenAI key", value: controller.credentialState.title)
        .foregroundStyle(.secondary)
    }
    .task { await controller.refreshCredentialState() }
  }
}

struct AssistantProviderSettingsView: View {
  let controller: AssistantProviderSettingsController

  @Environment(\.openURL) private var openURL
  @State private var candidate = ""
  @State private var showsDeleteConfirmation = false
  @State private var showsTextConsentConfirmation = false

  var body: some View {
    Form {
      providerSection
      openAICredentialSection
      if controller.credentialState == .savedAndVerified {
        textModelSection
        consentSection
      }
      voiceSection
      securitySection
      billingSection
    }
    .formStyle(.grouped)
    .navigationTitle("Assistant Providers")
    .task { await controller.refreshCredentialState() }
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
        "Text chat uses the selected provider. Voice, CarPlay, and App Intents always use Apple On Device. Apple Private Cloud Compute is not offered because Enchiridion has no verified PCC entitlement or runtime path."
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
      LabeledContent("Realtime", value: "Not available")
      Text(
        "A reviewed Realtime catalog is maintained separately, but there is no Realtime, WebRTC, audio upload, or voice model selection in Enchiridion yet."
      )
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

  private var deviceStorageCopy: String {
    #if os(iOS)
      "The key stays in this iPhone's passcode-protected Keychain. It does not sync or migrate to another device, and saving is refused without a passcode. Protected Keychain material may still be present in a same-device backup."
    #else
      "The key stays in this Mac's device-only Keychain and is available only while the Mac is unlocked. It does not sync or migrate to another device. Protected Keychain material may still be present in a same-device backup."
    #endif
  }

  private var openAIConsentDisclosure: String {
    """
    Enchiridion sends the current typed text or dictated text you submit, recent OpenAI text-chat history, and bounded matching task, note, or calendar context directly from this device to OpenAI. Your API key stays in this device's Keychain. Requests use store:false, though OpenAI may retain abuse-monitoring data for up to 30 days. API usage is billed separately from ChatGPT. Microphone audio, Enchiridion Voice, CarPlay, and App Intents remain Apple On Device.
    """
  }
}
