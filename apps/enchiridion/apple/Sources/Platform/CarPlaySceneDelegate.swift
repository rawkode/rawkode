#if os(iOS)
import AVFoundation
import CarPlay
import Combine
import UIKit

@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPInterfaceControllerDelegate {
    private var store: WorkspaceStore?
    private var controller: CPInterfaceController?
    private var voiceTemplate: CPVoiceControlTemplate?
    private var observations = Set<AnyCancellable>()
    private var connection: UUID?
    private var visible = false
    private var checkingAccount = false
    private var stateRetry: Task<Void, Never>?

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        guard #available(iOS 26.4, *), let store = EnchiridionAppDelegate.current?.store else { return }
        self.store = store
        controller = interfaceController
        interfaceController.delegate = self
        let token = UUID()
        connection = token
        let start = button("Start", symbol: "mic.fill") { [weak self] in self?.start() }
        let end = button("End", symbol: "stop.fill") { [weak self] in self?.store?.voice.stopForSurfaceLoss(.carplay) }
        let mute = button("Mute", symbol: "mic.slash.fill") { [weak self] in self?.store?.voice.toggleMute(surface: .carplay) }
        let unmute = button("Unmute", symbol: "mic.fill") { [weak self] in self?.store?.voice.toggleMute(surface: .carplay) }
        let retry = button("Check again", symbol: "arrow.clockwise") { [weak self] in self?.verifyAccount() }
        let states = [
            state("unavailable", title: "Voice unavailable. Check Enchiridion on iPhone.", buttons: [retry]),
            state("ready", title: "Talk through your day", buttons: [start]),
            state("connecting", title: "Connecting or ending…", buttons: [end]),
            state("listening", title: "Conversation active", buttons: [mute, end]),
            state("muted", title: "Microphone muted", buttons: [unmute, end]),
        ]
        let template = CPVoiceControlTemplate(voiceControlStates: states)
        voiceTemplate = template
        // Coalesce @Published will-change events onto a main-actor turn after assignment.
        for publisher in [store.voice.objectWillChange.eraseToAnyPublisher(), store.session.objectWillChange.eraseToAnyPublisher()] {
            publisher.sink { [weak self] _ in
                Task { @MainActor [weak self] in self?.updateState() }
            }.store(in: &observations)
        }
        interfaceController.setRootTemplate(template, animated: false) { [weak self] success, _ in
            Task { @MainActor [weak self] in
                guard let self, connection == token, success else { return }
                visible = true
                updateState()
            }
        }
        verifyAccount()
    }

    @available(iOS 26.4, *)
    private func button(_ title: String, symbol: String, action: @escaping @MainActor () -> Void) -> CPButton {
        let button = CPButton(image: UIImage(systemName: symbol)!) { _ in action() }
        button.title = title
        return button
    }

    @available(iOS 26.4, *)
    private func state(_ id: String, title: String, buttons: [CPButton]) -> CPVoiceControlState {
        let symbol = ["unavailable": "exclamationmark.circle", "ready": "mic", "connecting": "ellipsis", "listening": "waveform", "muted": "mic.slash"][id] ?? "waveform"
        let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 64, weight: .regular))
        let state = CPVoiceControlState(identifier: id, titleVariants: [title], image: image, repeats: false)
        state.actionButtons = buttons
        return state
    }

    private func verifyAccount() {
        guard !checkingAccount, let store, let token = connection else { return }
        checkingAccount = true
        updateState()
        Task { [weak self] in
            try? await store.session.verifyConnection()
            guard let self, connection == token else { return }
            checkingAccount = false
            updateState()
        }
    }

    private func start() {
        guard visible, !checkingAccount, let store, store.session.isConnected,
              AVAudioApplication.shared.recordPermission == .granted else { return }
        store.voice.start(surface: .carplay)
    }

    private func updateState() {
        guard visible, let template = voiceTemplate, let store else { return }
        let voice = store.voice
        let state: String
        if voice.surface == .carplay {
            state = voice.phase == .connected && !voice.isEnding ? (voice.isMuted ? "muted" : "listening") : "connecting"
        } else if voice.surface != nil || voice.isSendingText || checkingAccount || !store.session.isConnected || AVAudioApplication.shared.recordPermission != .granted {
            state = "unavailable"
        } else {
            state = "ready"
        }
        guard template.activeStateIdentifier != state else { stateRetry?.cancel(); stateRetry = nil; return }
        template.activateVoiceControlState(withIdentifier: state)
        // CarPlay may ignore a rapid phase change. Retry the latest state, never a captured stale state.
        if stateRetry == nil {
            stateRetry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                stateRetry = nil
                updateState()
            }
        }
    }

    func templateDidAppear(_ aTemplate: CPTemplate, animated: Bool) {
        guard aTemplate === voiceTemplate else { return }
        visible = true
        updateState()
    }

    func templateWillDisappear(_ aTemplate: CPTemplate, animated: Bool) {
        guard aTemplate === voiceTemplate else { return }
        visible = false
        store?.voice.stopForSurfaceLoss(.carplay)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        visible = false
        store?.voice.stopForSurfaceLoss(.carplay)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        visible = controller?.topTemplate === voiceTemplate && voiceTemplate != nil
        updateState()
    }

    func templateApplicationScene(_ scene: CPTemplateApplicationScene, didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        visible = false
        connection = nil
        checkingAccount = false
        store?.voice.stopForSurfaceLoss(.carplay)
        stateRetry?.cancel()
        stateRetry = nil
        observations.removeAll()
        interfaceController.delegate = nil
        voiceTemplate = nil
        controller = nil
        store = nil
    }
}
#endif
