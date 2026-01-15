import SwiftUI
import Combine

enum DisableModifier: String, CaseIterable, Identifiable {
    case none = "None"
    case command = "Command"
    case option = "Option"
    case control = "Control"
    case shift = "Shift"
    
    var id: String { self.rawValue }
    
    var flags: NSEvent.ModifierFlags? {
        switch self {
        case .none: return nil
        case .command: return .command
        case .option: return .option
        case .control: return .control
        case .shift: return .shift
        }
    }
}

class AppState: ObservableObject {
    private let focusEngine = FocusEngine()
    
    @Published var isEnabled: Bool {
        didSet {
            UserDefaults.standard.set(isEnabled, forKey: "isEnabled")
            updateEngineState()
        }
    }
    
    @Published var focusDelay: Double {
        didSet {
            UserDefaults.standard.set(focusDelay, forKey: "focusDelay")
            updateEngineConfig()
        }
    }
    
    @Published var disableModifier: DisableModifier {
        didSet {
            UserDefaults.standard.set(disableModifier.rawValue, forKey: "disableModifier")
            updateEngineConfig()
        }
    }
    
    @Published var isTrusted: Bool = AXIsProcessTrusted()
    
    init() {
        // Load Defaults
        self.isEnabled = UserDefaults.standard.object(forKey: "isEnabled") as? Bool ?? true
        self.focusDelay = UserDefaults.standard.object(forKey: "focusDelay") as? Double ?? 0.1
        
        if let savedModifier = UserDefaults.standard.string(forKey: "disableModifier"),
           let modifier = DisableModifier(rawValue: savedModifier) {
            self.disableModifier = modifier
        } else {
            self.disableModifier = .none
        }
        
        focusEngine.onTrustChange = { [weak self] trusted in
            DispatchQueue.main.async {
                self?.isTrusted = trusted
            }
        }
        
        updateEngineConfig()
        updateEngineState()
    }
    
    private func updateEngineConfig() {
        focusEngine.setConfiguration(
            delay: focusDelay,
            disableModifier: disableModifier.flags
        )
    }
    
    private func updateEngineState() {
        if isEnabled {
            focusEngine.start()
        } else {
            focusEngine.stop()
        }
    }
}