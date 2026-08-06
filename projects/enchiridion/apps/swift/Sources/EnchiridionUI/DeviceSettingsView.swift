// DeviceSettingsView.swift
// EnchiridionUI
//
// Task #96 (plan §Live Backend Connectivity (P8) scope item 5): "Surface
// device-enrollment status somewhere reachable in the navigation shell
// (RootView.swift on both platforms) — at minimum, a way to reach
// AddDeviceView/EnrollDeviceView (task #95) and see
// DeviceCredentialExpiryBanner if relevant. Keep this minimal — it doesn't
// need to be polished, just reachable."
//
// Before this task, `DeviceEnrollmentViews.swift`'s three real views
// (`AddDeviceView`/`EnrollDeviceView`/`DeviceCredentialExpiryBanner`, task
// #95) had NO call site anywhere in the app — same "shipped but not yet
// reachable from the live app" gap this codebase has already named for
// other P4/P5/P7 features at their own close-out (the gadget bridge, the
// assistant conversation UI before task #85). This file is the minimal fix:
// one plain screen hosting all three, reachable as a fourth `RootTab`.
//
// DELIBERATELY MINIMAL, PER THE TASK BRIEF: no onboarding flow, no
// attempt to auto-detect "is this the very first device" vs. "this device
// already has a credential" beyond a simple status line read once on
// appear — `EnrollDeviceView`/`AddDeviceView` already carry their own
// real functional logic (task #95); this file only makes them reachable
// and adds the one small piece neither of them provides on its own: a
// glance at whether THIS device currently holds a credential at all.
import EnchiridionCore
import SwiftUI

/// The status line at the top of `DeviceSettingsView` — pure decision
/// logic, factored out so it's unit-testable without a live SwiftUI host
/// (matches this codebase's established "extract the pure mapping, test it
/// directly" convention — e.g. `CanvasSaveOutcome`/`evaluateDeviceCredentialExpiry`).
enum DeviceEnrollmentStatusLine: Equatable {
  case checking
  case enrolled(deviceName: String)
  case notEnrolled

  var text: String {
    switch self {
    case .checking: "Checking this device's enrollment status…"
    case .enrolled(let deviceName): "This device is enrolled as \u{201C}\(deviceName)\u{201D}."
    case .notEnrolled: "This device is not enrolled yet."
    }
  }

  static func from(credential: DeviceAccessCredential?) -> DeviceEnrollmentStatusLine {
    guard let credential else { return .notEnrolled }
    return .enrolled(deviceName: credential.deviceName)
  }
}

/// The one reachable screen for everything task #95 built. See this file's
/// header — deliberately just a vertical stack of the three existing real
/// views, not a redesign of any of them.
public struct DeviceSettingsView: View {
  private let credentialStore: DeviceAccessCredentialStore
  private let provisioningClient: any DeviceEnrollmentProvisioningClient

  @State private var statusLine: DeviceEnrollmentStatusLine = .checking

  public init(
    credentialStore: DeviceAccessCredentialStore = DeviceAccessCredentialStore(),
    provisioningClient: any DeviceEnrollmentProvisioningClient = VaultDeviceEnrollmentClient(
      endpoint: AppBackendConfiguration.enrollProvisionURL)
  ) {
    self.credentialStore = credentialStore
    self.provisioningClient = provisioningClient
  }

  public var body: some View {
    Form {
      Section("This device") {
        Label(statusLine.text, systemImage: statusLine.iconName)
          .foregroundStyle(statusLine.tint)
        DeviceCredentialExpiryBanner(credentialStore: credentialStore, provisioningClient: provisioningClient)
      }

      Section("Enroll this device") {
        EnrollDeviceView(credentialStore: credentialStore, onEnrolled: { Task { await refreshStatus() } })
      }

      Section("Add another device") {
        AddDeviceView(
          provisioningClient: provisioningClient,
          existingCredentialProvider: {
            guard let credential = try? await credentialStore.readCredential() else { return nil }
            return ExistingDeviceAccessCredential(clientId: credential.clientId, clientSecret: credential.clientSecret)
          })
      }
    }
    #if os(macOS)
      .padding()
    #endif
    .navigationTitle("Devices")
    .task { await refreshStatus() }
  }

  private func refreshStatus() async {
    let credential = try? await credentialStore.readCredential()
    statusLine = .from(credential: credential)
  }
}

extension DeviceEnrollmentStatusLine {
  fileprivate var iconName: String {
    switch self {
    case .checking: "hourglass"
    case .enrolled: "checkmark.circle.fill"
    case .notEnrolled: "exclamationmark.circle"
    }
  }

  fileprivate var tint: Color {
    switch self {
    case .checking: .secondary
    case .enrolled: .green
    case .notEnrolled: .orange
    }
  }
}
