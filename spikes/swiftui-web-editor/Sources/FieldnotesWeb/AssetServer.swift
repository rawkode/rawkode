import Foundation
import Network
import UniformTypeIdentifiers

/// Serves only public bundled assets. Documents and native operations never use HTTP.
final class AssetServer {
    private let listener: NWListener
    private let root: URL
    private let queue = DispatchQueue(label: "fieldnotes.assets")

    init(root: URL, ready: @escaping (Result<URL, Error>) -> Void) throws {
        self.root = root.resolvingSymlinksInPath()
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port {
                    ready(.success(URL(string: "http://127.0.0.1:\(port)/")!))
                }
            case .failed(let error): ready(.failure(error))
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(connection, buffer: Data())
            self.queue.asyncAfter(deadline: .now() + 10) { connection.cancel() }
        }
        listener.start(queue: queue)
    }

    deinit { listener.cancel() }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            let buffer = buffer + (data ?? Data())
            guard buffer.count <= 16_384, error == nil else { connection.cancel(); return }
            if let header = String(data: buffer, encoding: .utf8), header.contains("\r\n\r\n") {
                self.respond(connection, header: header)
            } else if !complete {
                self.receive(connection, buffer: buffer)
            } else { connection.cancel() }
        }
    }

    private func respond(_ connection: NWConnection, header: String) {
        let parts = header.components(separatedBy: "\r\n")[0].split(separator: " ")
        guard parts.count == 3 else { connection.cancel(); return }
        let path = String(parts[1]).components(separatedBy: "?")[0].removingPercentEncoding ?? ""
        if path == "/api/metadata" {
            send(connection, status: "501 Not Implemented", type: "application/json", data: Data("{\"error\":\"Fetching new link previews is not available in the SwiftUI spike. Import a note with existing metadata.\"}".utf8))
            return
        }
        guard parts[0] == "GET", path.hasPrefix("/") else {
            send(connection, status: "405 Method Not Allowed", type: "text/plain", data: Data()); return
        }
        let file = root.appendingPathComponent(path == "/" ? "index.html" : String(path.dropFirst())).resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            send(connection, status: "404 Not Found", type: "text/plain", data: Data()); return
        }
        let types = ["js": "text/javascript", "css": "text/css", "html": "text/html", "wasm": "application/wasm", "svg": "image/svg+xml"]
        let type = types[file.pathExtension] ?? UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        send(connection, status: "200 OK", type: type, data: data)
    }

    private func send(_ connection: NWConnection, status: String, type: String, data: Data) {
        let headers = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(data.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n"
        connection.send(content: Data(headers.utf8) + data, completion: .contentProcessed { _ in connection.cancel() })
    }
}
