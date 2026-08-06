// DeviceEnrollmentViews.swift
// EnchiridionUI
//
// Plan §Live Backend Connectivity (P8), "Device auth" paragraph + §Native
// apps: the actual pairing UI for `EnchiridionCore/DeviceEnrollmentPairing.swift`'s
// protocol (read that file's header FIRST — it has the full role split and
// citations). Three views, one per plan requirement:
//
//   - `AddDeviceView` — the ALREADY-ENROLLED device's role: mint a fresh
//     credential for a NEW device via `workers/vault/src/enroll-routes.ts`'s
//     `/enroll/provision`, then display it out of band (QR code + a
//     copyable text fallback) for the new device to consume. Never writes
//     to this device's OWN `DeviceAccessCredentialStore`.
//   - `EnrollDeviceView` — the NEW device's role: paste (or, once scanned,
//     the decoded text of) the payload `AddDeviceView` displayed, and save
//     it into THIS device's own `DeviceAccessCredentialStore`. Makes no
//     network call at all (see DeviceEnrollmentPairing.swift's header on
//     why that's a hard requirement, not a missed optimization).
//   - `DeviceCredentialExpiryBanner` — plan: "In-app expiry warning +
//     re-enrollment UX before a token goes dark." A still-valid device can
//     RENEW ITS OWN credential by calling `/enroll/provision` for itself
//     (its still-valid credential authenticates the call, same as it would
//     for minting a different device's credential) and overwriting its own
//     Keychain entry directly — no second device or QR/paste step needed,
//     since the "new" and "already-enrolled" device are the same device in
//     this case.
//
// QR SCOPE DECISION (task's own sanctioned v1 shape: "a manual code with QR
// as an enhancement on iOS is a reasonable v1" — camera availability
// differs by platform): QR **generation/display** is implemented here for
// real (`DeviceQRCodeView`, CoreImage, works identically on iOS and macOS —
// no platform branch needed). QR **scanning** (camera capture) is
// DELIBERATELY NOT implemented in this pass — it needs `AVCaptureSession`
// hardware that cannot be exercised or tested in this sandbox at all (no
// simulator camera feed), and the task's own framing explicitly allows
// manual entry as a complete v1. `EnrollDeviceView`'s text field is the
// real, fully-functional v1 path on both platforms; a follow-up task
// wiring `AVCaptureMetadataOutput` behind `PairingScanning`-style protocol
// seam (so the capture session itself stays untested but the decode logic
// — already covered by `DeviceEnrollmentPairingCodecTests` — would not
// need to change) is the natural next step, not a redesign.

import EnchiridionCore
import SwiftUI

#if canImport(CoreImage)
  import CoreImage
  import CoreImage.CIFilterBuiltins
#endif

// MARK: - QR code rendering

/// Renders `text` as a QR code image. Pure, synchronous, and
/// platform-uniform (`CIImage` -> `CGImage` -> SwiftUI `Image(decorative:)`
/// needs no `UIImage`/`NSImage` bridging, so this needs no `#if os(...)`
/// split — matches `PageEditorView.swift`'s stated preference for keeping
/// `EnchiridionUI` platform-branch-free wherever the underlying APIs
/// genuinely don't differ, see that file's header).
enum DeviceQRCodeRenderer {
  /// Returns `nil` if CoreImage's QR filter itself fails (extremely rare —
  /// e.g. an absurdly long input string exceeding QR's data capacity) or
  /// if this platform has no CoreImage (never true on iOS/macOS, guarded
  /// defensively since `EnchiridionCore`'s `.watchOS` platform pin means
  /// this package is technically built for a platform where a caller
  /// COULD reference this type, even though no UI target does today).
  static func cgImage(for text: String, scale: CGFloat = 10) -> CGImage? {
    #if canImport(CoreImage)
      guard let data = text.data(using: .utf8) else { return nil }
      let filter = CIFilter.qrCodeGenerator()
      filter.message = data
      filter.correctionLevel = "M"
      guard let outputImage = filter.outputImage else { return nil }
      let transformed = outputImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      let context = CIContext()
      return context.createCGImage(transformed, from: transformed.extent)
    #else
      return nil
    #endif
  }
}

/// Displays `text` as a QR code, falling back to a plain message if
/// rendering fails (never crashes the pairing flow over a QR-specific
/// failure — the copyable text field next to it is always the reliable
/// fallback).
struct DeviceQRCodeView: View {
  let text: String

  var body: some View {
    if let cgImage = DeviceQRCodeRenderer.cgImage(for: text) {
      Image(decorative: cgImage, scale: 1, orientation: .up)
        .interpolation(.none)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(maxWidth: 240, maxHeight: 240)
        .accessibilityLabel("QR code for device pairing")
    } else {
      Text("QR code unavailable — use the code below instead.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}

// MARK: - Already-enrolled device: mint + display

/// The already-enrolled device's role. See this file's header.
public struct AddDeviceView: View {
  private let provisioningClient: any DeviceEnrollmentProvisioningClient
  private let existingCredentialProvider: @Sendable () async -> ExistingDeviceAccessCredential?

  @State private var deviceName: String = ""
  @State private var isProvisioning = false
  @State private var payload: DeviceEnrollmentPairingPayload?
  @State private var encodedPayload: String?
  @State private var errorMessage: String?

  public init(
    provisioningClient: any DeviceEnrollmentProvisioningClient,
    existingCredentialProvider: @escaping @Sendable () async -> ExistingDeviceAccessCredential?
  ) {
    self.provisioningClient = provisioningClient
    self.existingCredentialProvider = existingCredentialProvider
  }

  public var body: some View {
    Form {
      Section {
        Text(
          "Enter a name for the new device, then generate a pairing code. "
            + "Keep this screen open and enter the code on the new device right away — "
            + "it is only shown here once."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
      }

      Section("New device") {
        TextField("Device name (e.g. \"David's iPad\")", text: $deviceName)
          #if os(iOS)
            .textInputAutocapitalization(.words)
          #endif
        Button {
          Task { await provision() }
        } label: {
          if isProvisioning {
            ProgressView()
          } else {
            Text("Generate Pairing Code")
          }
        }
        .disabled(isProvisioning || deviceName.trimmingCharacters(in: .whitespaces).isEmpty)
      }

      if let errorMessage {
        Section {
          Text(errorMessage).foregroundStyle(.red)
        }
      }

      if let encodedPayload, let payload {
        Section("Scan or paste on the new device") {
          VStack(alignment: .center, spacing: 12) {
            DeviceQRCodeView(text: encodedPayload)
            Text(encodedPayload)
              .font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
              .multilineTextAlignment(.leading)
            Text("For \(payload.deviceName) — pairing code \(payload.pairingCode)")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity)
        }
      }
    }
    #if os(macOS)
      .padding()
    #endif
  }

  private func provision() async {
    errorMessage = nil
    payload = nil
    encodedPayload = nil
    guard let existingCredential = await existingCredentialProvider() else {
      errorMessage = "This device has no Access credential of its own yet — it must already be enrolled before it can enroll another device."
      return
    }
    isProvisioning = true
    defer { isProvisioning = false }
    do {
      let trimmedName = deviceName.trimmingCharacters(in: .whitespaces)
      let code = PairingCode.generate()
      let result = try await provisioningClient.provisionDevice(
        deviceName: trimmedName, pairingCode: code, existingCredential: existingCredential)
      payload = result
      encodedPayload = try DeviceEnrollmentPairingCodec.encode(result)
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? "Could not provision the new device: \(error)"
    }
  }
}

// MARK: - New device: paste + save

/// The new, still-unenrolled device's role. See this file's header. Makes
/// NO network call — only decodes the pasted payload and writes to this
/// device's own Keychain.
public struct EnrollDeviceView: View {
  private let credentialStore: DeviceAccessCredentialStore
  private let onEnrolled: (@Sendable () -> Void)?

  @State private var pastedCode: String = ""
  @State private var errorMessage: String?
  @State private var enrolledDeviceName: String?

  public init(credentialStore: DeviceAccessCredentialStore, onEnrolled: (@Sendable () -> Void)? = nil) {
    self.credentialStore = credentialStore
    self.onEnrolled = onEnrolled
  }

  public var body: some View {
    Form {
      if let enrolledDeviceName {
        Section {
          Label("Enrolled as \"\(enrolledDeviceName)\"", systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
        }
      } else {
        Section {
          Text(
            "On an already-enrolled device, open \"Add a Device,\" generate a pairing code, "
              + "then paste it below (or scan its QR code, once scanning is added)."
          )
          .font(.footnote)
          .foregroundStyle(.secondary)
        }

        Section("Pairing code") {
          TextEditor(text: $pastedCode)
            .frame(minHeight: 100)
            .font(.system(.caption, design: .monospaced))
          Button("Enroll This Device") {
            enroll()
          }
          .disabled(pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }

        if let errorMessage {
          Section {
            Text(errorMessage).foregroundStyle(.red)
          }
        }
      }
    }
    #if os(macOS)
      .padding()
    #endif
  }

  private func enroll() {
    errorMessage = nil
    do {
      let payload = try DeviceEnrollmentPairingCodec.decode(pastedCode)
      Task {
        do {
          try await credentialStore.save(credential: payload.asDeviceAccessCredential)
          await MainActor.run {
            enrolledDeviceName = payload.deviceName
            onEnrolled?()
          }
        } catch {
          await MainActor.run {
            errorMessage = "Could not save this device's credential: \(error)"
          }
        }
      }
    } catch {
      errorMessage = "That doesn't look like a valid pairing code — make sure you copied the whole thing."
    }
  }
}

// MARK: - Expiry warning + self-renewal

/// Plan: "In-app expiry warning + re-enrollment UX before a token goes
/// dark." Reads the current device's own stored credential, evaluates
/// `evaluateDeviceCredentialExpiry` (EnchiridionCore/DeviceEnrollmentPairing.swift),
/// and — if it's expiring soon or already expired — offers a one-tap
/// "Renew Now" that re-mints ITS OWN credential (this device authenticates
/// the renewal with its still-valid existing credential, the same
/// `/enroll/provision` call `AddDeviceView` makes for a DIFFERENT device,
/// just naming itself) and overwrites its own Keychain entry directly — no
/// second device or QR/paste step needed for a same-device renewal.
public struct DeviceCredentialExpiryBanner: View {
  private let credentialStore: DeviceAccessCredentialStore
  private let provisioningClient: any DeviceEnrollmentProvisioningClient
  private let warningWindow: TimeInterval
  private let now: () -> Date

  @State private var status: DeviceCredentialExpiryStatus?
  @State private var isRenewing = false
  @State private var renewalError: String?

  public init(
    credentialStore: DeviceAccessCredentialStore,
    provisioningClient: any DeviceEnrollmentProvisioningClient,
    warningWindow: TimeInterval = 30 * 24 * 60 * 60,
    now: @escaping () -> Date = Date.init
  ) {
    self.credentialStore = credentialStore
    self.provisioningClient = provisioningClient
    self.warningWindow = warningWindow
    self.now = now
  }

  public var body: some View {
    Group {
      switch status {
      case .none, .healthy:
        EmptyView()
      case .expiringSoon(let daysRemaining):
        banner(
          message: "Your device's access credential expires in \(daysRemaining) day\(daysRemaining == 1 ? "" : "s").",
          tint: .orange
        )
      case .expired:
        banner(message: "Your device's access credential has expired. Renew it now to keep syncing.", tint: .red)
      }
    }
    .task { await refreshStatus() }
  }

  @ViewBuilder
  private func banner(message: String, tint: Color) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(tint)
      VStack(alignment: .leading, spacing: 4) {
        Text(message).font(.footnote)
        if let renewalError {
          Text(renewalError).font(.caption2).foregroundStyle(.red)
        }
        Button {
          Task { await renew() }
        } label: {
          if isRenewing {
            ProgressView()
          } else {
            Text("Renew Now")
          }
        }
        .disabled(isRenewing)
      }
      Spacer()
    }
    .padding(8)
    .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
  }

  private func refreshStatus() async {
    guard let credential = try? await credentialStore.readCredential() else {
      status = nil
      return
    }
    status = evaluateDeviceCredentialExpiry(now: now(), expiresAt: credential.expiresAt, warningWindow: warningWindow)
  }

  private func renew() async {
    renewalError = nil
    guard let credential = try? await credentialStore.readCredential() else {
      renewalError = "No existing credential to renew from."
      return
    }
    isRenewing = true
    defer { isRenewing = false }
    do {
      let code = PairingCode.generate()
      let result = try await provisioningClient.provisionDevice(
        deviceName: credential.deviceName,
        pairingCode: code,
        existingCredential: ExistingDeviceAccessCredential(
          clientId: credential.clientId, clientSecret: credential.clientSecret)
      )
      try await credentialStore.save(credential: result.asDeviceAccessCredential)
      await refreshStatus()
    } catch {
      renewalError = "Renewal failed: \((error as? LocalizedError)?.errorDescription ?? "\(error)")"
    }
  }
}
