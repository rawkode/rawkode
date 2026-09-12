import Foundation
import Darwin

struct EngineState: Decodable {
    let nodeName: String
    let localSlot: Int
    let enabled: Bool
    let paired: Bool
    let keyboardPresent: Bool?
    let mousePresent: Bool?
    let networkStatus: String
    let peers: Int
    let lastEvent: String
}

private struct EngineEvent: Decodable {
    let type: String
    let state: EngineState?
    let ok: Bool?
    let message: String?
    let pairingCode: String?
}

/// The native UI owns one Rust child and communicates only through its private pipes.
@MainActor
final class EngineClient {
    var onState: ((EngineState) -> Void)?
    var onResult: ((Bool, String, String?) -> Void)?
    var onFailure: ((String) -> Void)?
    private var process: Process?
    private var input: FileHandle?
    private var nextID = 1
    private var stopping = false

    func start() {
        guard process == nil else { return }
        let engine = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/multipass-engine")
        guard FileManager.default.isExecutableFile(atPath: engine.path) else {
            onFailure?("The bundled Multipass engine is missing. Rebuild the app.")
            return
        }
        let child = Process()
        child.executableURL = engine
        child.arguments = ["--stdio"]
        let stdin = Pipe(), stdout = Pipe()
        child.standardInput = stdin
        child.standardOutput = stdout
        // Protocol errors are reported through stdout; diagnostic stderr has no UI role.
        child.standardError = FileHandle.nullDevice
        input = stdin.fileHandleForWriting
        process = child
        child.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self, !self.stopping else { return }
                self.failAndStop("Multipass engine stopped (status \(process.terminationStatus)). Restart the app.")
            }
        }
        do { try child.run() }
        catch { failAndStop("Cannot start Multipass engine: \(error.localizedDescription)"); return }
        let handle = stdout.fileHandleForReading
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buffer = Data()
            do {
                while let data = try handle.read(upToCount: 4096), !data.isEmpty {
                    buffer.append(data)
                    while let newline = buffer.firstIndex(of: 10) {
                        let frame = Data(buffer[..<newline])
                        buffer.removeSubrange(...newline)
                        guard frame.count <= 16384 else { throw EngineReadError.oversized }
                        Task { @MainActor [weak self] in self?.receive(frame) }
                    }
                    if buffer.count > 16384 { throw EngineReadError.oversized }
                }
                Task { @MainActor [weak self] in self?.failAndStop("Multipass engine closed its response stream.") }
            } catch {
                Task { @MainActor [weak self] in self?.failAndStop("Cannot read Multipass engine responses.") }
            }
        }
        send("status")
    }

    func send(_ command: String, values: [String: Any] = [:]) {
        guard let input, !stopping else { return }
        var payload = values
        payload["id"] = nextID
        payload["command"] = command
        nextID += 1
        do {
            var data = try JSONSerialization.data(withJSONObject: payload)
            data.append(10)
            guard data.count <= 8192 else {
                onResult?(false, "Command is too large.", nil)
                return
            }
            try input.write(contentsOf: data)
        } catch { failAndStop("Cannot send commands to Multipass engine.") }
    }

    func stop() {
        guard !stopping else { return }
        send("shutdown")
        stopping = true
        try? input?.close()
        input = nil
        // EOF also stops the engine if shutdown could not be delivered.
        if let process {
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if process.isRunning {
                    process.terminate()
                    Self.forceStopAfterGrace(process)
                }
            }
        }
    }

    private func failAndStop(_ message: String) {
        guard !stopping else { return }
        stopping = true
        try? input?.close()
        input = nil
        if let process, process.isRunning {
            process.terminate()
            Self.forceStopAfterGrace(process)
        }
        onFailure?(message)
    }

    nonisolated private static func forceStopAfterGrace(_ process: Process) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }

    private func receive(_ data: Data) {
        guard !stopping else { return }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let event = try? decoder.decode(EngineEvent.self, from: data) else {
            failAndStop("Invalid response from Multipass engine.")
            return
        }
        switch event.type {
        case "state":
            guard let state = event.state, (1...3).contains(state.localSlot), state.peers >= 0 else { failAndStop("Incomplete engine state."); return }
            onState?(state)
        case "result":
            guard let ok = event.ok, let message = event.message else { failAndStop("Incomplete engine result."); return }
            onResult?(ok, message, event.pairingCode)
        default: failAndStop("Incompatible engine response.")
        }
    }
}

private enum EngineReadError: Error { case oversized }
