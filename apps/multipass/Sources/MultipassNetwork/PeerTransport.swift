import Foundation
import Network
import Security

@MainActor
public final class PeerTransport {
    public var onStatus: ((String) -> Void)?
    public var onPeers: (([String]) -> Void)?
    public var onRequest: ((UUID, Int, RequestLease) -> Void)?

    private let nodeID: UUID
    private let name: String
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var endpoints: [NWEndpoint] = []
    private var sessions: [UUID: NWConnection] = [:]
    private var leases: [UUID: RequestLease] = [:]
    private var generation = UUID()
    private var secret = Data()
    private let serviceType = "_multipass._tcp"

    public init(nodeID: UUID, name: String) {
        self.nodeID = nodeID
        self.name = name
    }

    public func start(secret: Data) {
        stop()
        guard secret.count == 32 else { onStatus?("Pairing key must contain 32 bytes."); return }
        self.secret = secret
        let current = generation
        do {
            let listener = try NWListener(using: .tcp)
            listener.service = NWListener.Service(name: nodeID.uuidString, type: serviceType)
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    guard let self, self.generation == current else { connection.cancel(); return }
                    self.accept(connection, generation: current)
                }
            }
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    switch state {
                    case .ready: self.onStatus?("Listening for paired Macs as \(self.name).")
                    case .failed(let error): self.onStatus?("Listener failed: \(error.localizedDescription)")
                    case .waiting(let error): self.onStatus?("Listener waiting: \(error.localizedDescription)")
                    default: break
                    }
                }
            }
            self.listener = listener
            listener.start(queue: .main)
            let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: .tcp)
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    self.endpoints = results.map(\.endpoint).filter { endpoint in
                        if case .service(let name, _, _, _) = endpoint {
                            return name.caseInsensitiveCompare(self.nodeID.uuidString) != .orderedSame
                        }
                        return false
                    }
                    self.onPeers?(self.endpoints.map { endpoint in
                        if case .service(let name, _, _, _) = endpoint { return name }
                        return endpoint.debugDescription
                    }.sorted())
                }
            }
            browser.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == current else { return }
                    switch state {
                    case .failed(let error):
                        self.endpoints = []; self.onPeers?([])
                        self.onStatus?("Discovery failed: \(error.localizedDescription)")
                    case .waiting(let error): self.onStatus?("Discovery waiting: \(error.localizedDescription)")
                    default: break
                    }
                }
            }
            self.browser = browser
            browser.start(queue: .main)
        } catch { onStatus?("Cannot start local networking: \(error.localizedDescription)"); stop() }
    }

    public func stop() {
        generation = UUID()
        listener?.cancel(); listener = nil
        browser?.cancel(); browser = nil
        for connection in sessions.values { connection.cancel() }
        sessions.removeAll()
        for lease in leases.values { lease.invalidate() }
        leases.removeAll()
        endpoints.removeAll()
        secret = Data()
        onPeers?([])
    }

    var listeningPort: NWEndpoint.Port? { listener?.port }
    var activeSessionCount: Int { sessions.count }

    public func announceAttachment(slot: Int, isStillCurrent: @escaping () -> Bool) {
        announceAttachment(slot: slot, to: endpoints, isStillCurrent: isStillCurrent)
    }

    func announceAttachment(slot: Int, to destinations: [NWEndpoint], isStillCurrent: @escaping () -> Bool) {
        guard listener != nil, (1...3).contains(slot), isStillCurrent() else { return }
        let current = generation
        for endpoint in destinations.prefix(32) {
            let connection = NWConnection(to: endpoint, using: .tcp)
            guard let id = register(connection, generation: current) else { continue }
            connection.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.active(id, current) else { return }
                    if case .ready = state {
                        connection.stateUpdateHandler = nil
                        self.receiveFrame(connection, id: id, generation: current) { [weak self] data in
                            guard let self else { connection.cancel(); return }
                            guard self.active(id, current), isStillCurrent(),
                                  let challenge = try? JSONDecoder().decode(WireProtocol.Challenge.self, from: data),
                                  challenge.version == WireProtocol.version,
                                  let random = Data(base64Encoded: challenge.challenge), random.count == 32,
                                  let signed = try? WireProtocol.sign(senderID: self.nodeID, slot: slot, challenge: challenge.challenge, secret: self.secret)
                            else { self.finish(id); return }
                            self.sendFrame(signed, connection: connection, id: id, generation: current) { [weak self] in
                                guard let self else { connection.cancel(); return }
                                // Hold the claim's connection while the keyboard attachment remains current.
                                self.receiveExactly(1, connection: connection, id: id, generation: current) { [weak self] _ in self?.finish(id) }
                                Task { @MainActor [weak self] in
                                    while let self, self.active(id, current) {
                                        guard isStillCurrent() else { self.finish(id); return }
                                        try? await Task.sleep(nanoseconds: 50_000_000)
                                    }
                                }
                            }
                        }
                    } else if case .failed = state { self.finish(id) }
                }
            }
            connection.start(queue: .main)
        }
    }

    private func accept(_ connection: NWConnection, generation current: UUID) {
        guard let id = register(connection, generation: current) else { return }
        connection.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.active(id, current) else { return }
                if case .ready = state {
                    connection.stateUpdateHandler = nil
                    var bytes = [UInt8](repeating: 0, count: 32)
                    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { self.finish(id); return }
                    let challenge = Data(bytes).base64EncodedString()
                    guard let data = try? WireProtocol.encode(WireProtocol.Challenge(version: WireProtocol.version, challenge: challenge)) else { self.finish(id); return }
                    self.sendFrame(data, connection: connection, id: id, generation: current) { [weak self] in
                        guard let self else { connection.cancel(); return }
                        self.receiveFrame(connection, id: id, generation: current) { [weak self] data in
                            guard let self, self.active(id, current) else { return }
                            var verifier = WireProtocol.Verifier(challenge: challenge)
                            let claim = verifier.verify(data, secret: self.secret)
                            guard let claim, claim.senderID != self.nodeID else { self.finish(id); return }
                            let lease = RequestLease()
                            self.leases[id] = lease
                            // EOF, failure, or any unexpected extra byte revokes the permission.
                            self.receiveExactly(1, connection: connection, id: id, generation: current) { [weak self] _ in self?.finish(id) }
                            Task { @MainActor [weak self] in
                                try? await Task.sleep(nanoseconds: 1_000_000_000)
                                guard let self, self.active(id, current) else { return }
                                self.finish(id)
                            }
                            self.onRequest?(claim.senderID, claim.slot, lease)
                        }
                    }
                } else if case .failed = state { self.finish(id) }
            }
        }
        connection.start(queue: .main)
    }

    private func active(_ id: UUID, _ current: UUID) -> Bool { generation == current && sessions[id] != nil }

    private func register(_ connection: NWConnection, generation current: UUID) -> UUID? {
        guard current == generation, sessions.count < 64 else { connection.cancel(); return nil }
        let id = UUID()
        sessions[id] = connection
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self, self.active(id, current) else { return }
            self.finish(id)
        }
        return id
    }

    private func finish(_ id: UUID) {
        leases.removeValue(forKey: id)?.invalidate()
        let connection = sessions.removeValue(forKey: id)
        connection?.stateUpdateHandler = nil
        connection?.cancel()
    }

    private func sendFrame(_ data: Data, connection: NWConnection, id: UUID, generation current: UUID, completion: @escaping @MainActor () -> Void) {
        guard active(id, current), !data.isEmpty, data.count <= WireProtocol.maximumFrame else { finish(id); return }
        let count = UInt32(data.count)
        var frame = Data([UInt8((count >> 24) & 255), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255)])
        frame.append(data)
        connection.send(content: frame, completion: .contentProcessed { [weak self] error in
            Task { @MainActor in
                guard let self, self.active(id, current) else { return }
                guard error == nil else { self.finish(id); return }
                completion()
            }
        })
    }

    private func receiveFrame(_ connection: NWConnection, id: UUID, generation current: UUID, completion: @escaping @MainActor (Data) -> Void) {
        receiveExactly(4, connection: connection, id: id, generation: current) { [weak self] header in
            guard let self else { connection.cancel(); return }
            let length = header.reduce(0) { ($0 << 8) | Int($1) }
            guard length > 0, length <= WireProtocol.maximumFrame else { self.finish(id); return }
            self.receiveExactly(length, connection: connection, id: id, generation: current, completion: completion)
        }
    }

    private func receiveExactly(_ count: Int, connection: NWConnection, id: UUID, generation current: UUID, accumulated: Data = Data(), completion: @escaping @MainActor (Data) -> Void) {
        guard active(id, current) else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: count - accumulated.count) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, self.active(id, current) else { return }
                var combined = accumulated
                if let data { combined.append(data) }
                guard error == nil else { self.finish(id); return }
                if combined.count == count { completion(combined) }
                else if complete || data?.isEmpty != false { self.finish(id) }
                else { self.receiveExactly(count, connection: connection, id: id, generation: current, accumulated: combined, completion: completion) }
            }
        }
    }
}
