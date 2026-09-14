import Foundation
import Network
#if canImport(Darwin)
import Darwin
#endif

enum LinkMetadataResolver {
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var completed = false
        func run(_ action: () -> Void) {
            lock.lock(); defer { lock.unlock() }
            guard !completed else { return }
            completed = true
            action()
        }
    }

    enum Failure: LocalizedError {
        case invalidURL, response(Int), tooLarge, unsupportedContent
        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Enter a public http or https URL on a standard port without a username or password."
            case .response(let code): return "The website returned HTTP \(code)."
            case .tooLarge: return "The metadata response exceeds the 2 MB limit."
            case .unsupportedContent: return "This link does not provide a web page or supported video."
            }
        }
    }

    static func validatedURL(_ source: String) -> URL? {
        guard let url = URL(string: source.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.port == nil || [80, 443].contains(url.port!),
              isSafeHostLiteral(host) else { return nil }
        return url
    }

    private static func isSafeHostLiteral(_ host: String) -> Bool {
        let normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if normalized == "localhost" || normalized.hasSuffix(".localhost") ||
            normalized.hasSuffix(".local") || normalized.hasSuffix(".internal") {
            return false
        }
        if let bytes = ipv4Bytes(normalized) {
            return isSafeIPv4(bytes)
        }
        if let bytes = ipv6Bytes(normalized) {
            if bytes.prefix(12).allSatisfy({ $0 == 0 }) ||
                (bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff) {
                return isSafeIPv4(Array(bytes.suffix(4)))
            }
            let first = bytes[0]
            let isUnspecified = bytes.allSatisfy { $0 == 0 }
            let isLoopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
            let isUniqueLocal = (first & 0xfe) == 0xfc
            let isLinkLocal = first == 0xfe && (bytes[1] & 0xc0) == 0x80
            let isMulticast = first == 0xff
            let isDocumentation = bytes.starts(with: [0x20, 0x01, 0x0d, 0xb8])
            return !isUnspecified && !isLoopback && !isUniqueLocal &&
                !isLinkLocal && !isMulticast && !isDocumentation
        }
        return true
    }

    private static func isSafeIPv4(_ bytes: [UInt8]) -> Bool {
        guard bytes.count == 4 else { return false }
        let first = bytes[0], second = bytes[1]
        return first != 0 && first != 10 && first != 127 &&
            !(first == 100 && (64...127).contains(second)) &&
            !(first == 169 && second == 254) &&
            !(first == 172 && (16...31).contains(second)) &&
            !(first == 192 && second == 168) &&
            !(first == 192 && second == 0 && bytes[2] == 0) &&
            !(first == 192 && second == 0 && bytes[2] == 2) &&
            !(first == 198 && second == 18) &&
            !(first == 198 && second == 19) &&
            !(first == 198 && second == 51 && bytes[2] == 100) &&
            !(first == 203 && second == 0 && bytes[2] == 113) &&
            first < 224
    }

    private static func ipv4Bytes(_ host: String) -> [UInt8]? {
        var address = in_addr()
        guard host.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 else { return nil }
        let value = UInt32(bigEndian: address.s_addr)
        return [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff),
        ]
    }

    private static func ipv6Bytes(_ host: String) -> [UInt8]? {
        var address = in6_addr()
        guard host.withCString({ inet_pton(AF_INET6, $0, &address) }) == 1 else { return nil }
        return withUnsafeBytes(of: &address) { Array($0.prefix(16)) }
    }

    private static func publicEndpoints(_ host: String) -> [String] {
        guard isSafeHostLiteral(host) else { return [] }
        if ipv4Bytes(host) != nil || ipv6Bytes(host) != nil { return [host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))] }
        var result: UnsafeMutablePointer<addrinfo>?
        guard host.withCString({ getaddrinfo($0, nil, nil, &result) }) == 0,
              let result else { return [] }
        defer { freeaddrinfo(result) }
        var endpoints: [String] = []
        var current: UnsafeMutablePointer<addrinfo>? = result
        while let info = current {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard let address = info.pointee.ai_addr,
                  getnameinfo(address, info.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0,
                  isSafeHostLiteral(String(cString: buffer)) else { return [] }
            endpoints.append(String(cString: buffer))
            current = info.pointee.ai_next
        }
        return Array(Set(endpoints))
    }

    private static func resolvesToPublicAddress(_ host: String) -> Bool {
        !publicEndpoints(host).isEmpty
    }

    private static func isSafeURL(_ url: URL) -> Bool {
        guard validatedURL(url.absoluteString) != nil, let host = url.host else { return false }
        return resolvesToPublicAddress(host)
    }

    /// The network client is never handed an unchecked hostname. We resolve all addresses first,
    /// reject private answers, and connect to one of the vetted IP endpoints.
    static func publicURL(_ url: URL) -> URL? {
        isSafeURL(url) ? url : nil
    }

    static func resolve(_ source: String) async throws -> LinkMetadata {
        guard let url = validatedURL(source) else { throw Failure.invalidURL }
        let page = try await fetchFollowingRedirects(url)
        if isVideoMIME(page.mime) {
            return LinkMetadata(title: page.url.lastPathComponent, playback: .directVideo(page.url))
        }
        guard page.mime.contains("html") || page.mime.isEmpty else { throw Failure.unsupportedContent }
        let html = String(data: page.data, encoding: .utf8) ?? String(decoding: page.data, as: UTF8.self)
        let parsed = parseHTML(html, baseURL: page.url)
        var metadata = parsed.metadata
        if let endpoint = parsed.oEmbedURL {
            do {
                let response = try await fetchFollowingRedirects(endpoint)
                metadata = try mergeOEmbed(response.data, into: metadata, baseURL: response.url)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                metadata.discoveryNote = "Player metadata could not be loaded: \(error.localizedDescription)"
            }
        }
        return metadata
    }

    static func fetchImage(_ url: URL) async throws -> Data {
        let response = try await fetchFollowingRedirects(url)
        guard response.mime.hasPrefix("image/") else { throw Failure.unsupportedContent }
        return response.data
    }

    private struct Response {
        var data: Data
        var url: URL
        var mime: String
        var redirect: URL?
    }

    private struct RawResponse {
        var status: Int
        var headers: [String: String]
        var body: Data
    }

    private static func fetchFollowingRedirects(_ initialURL: URL) async throws -> Response {
        var url = initialURL
        for _ in 0..<5 {
            let response = try await fetch(url)
            guard let redirect = response.redirect else { return response }
            guard isSafeURL(redirect) else { throw Failure.invalidURL }
            url = redirect
        }
        throw Failure.invalidURL
    }

    private static func fetch(_ url: URL) async throws -> Response {
        guard isSafeURL(url) else { throw Failure.invalidURL }
        guard let host = url.host else { throw Failure.invalidURL }
        let endpoints = publicEndpoints(host)
        guard !endpoints.isEmpty else { throw Failure.invalidURL }
        var lastError: Error?
        for endpoint in endpoints {
            do {
                let response = try await withTimeout {
                    try await exchange(url, endpoint: endpoint)
                }
                let mime = response.headers["content-type"]?.split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() } ?? ""
                if (300..<400).contains(response.status),
                   let location = response.headers["location"],
                   let redirect = URL(string: location, relativeTo: url)?.absoluteURL {
                    return Response(data: Data(), url: url, mime: mime, redirect: redirect)
                }
                guard (200..<300).contains(response.status) else { throw Failure.response(response.status) }
                if isVideoMIME(mime) { return Response(data: Data(), url: url, mime: mime, redirect: nil) }
                return Response(data: response.body, url: url, mime: mime, redirect: nil)
            } catch let error as Failure {
                throw error
            } catch {
                lastError = error
            }
        }
        throw lastError ?? Failure.unsupportedContent
    }

    private static func withTimeout<T>(_ operation: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: 20_000_000_000)
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    private static func exchange(_ url: URL, endpoint: String) async throws -> RawResponse {
        guard let scheme = url.scheme?.lowercased(), let host = url.host else { throw Failure.invalidURL }
        let port = UInt16(url.port ?? (scheme == "https" ? 443 : 80))
        let tls: NWParameters
        if scheme == "https" {
            let options = NWProtocolTLS.Options()
            sec_protocol_options_set_tls_server_name(options.securityProtocolOptions, host)
            tls = NWParameters(tls: options)
        } else {
            tls = NWParameters.tcp
        }
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw Failure.invalidURL }
        let connection = NWConnection(host: NWEndpoint.Host(endpoint), port: nwPort, using: tls)
        defer { connection.cancel() }
        try await connect(connection)
        let hostHeader = host.contains(":") ? "[\(host)]" : host
        let portHeader = url.port.map { ":\($0)" } ?? ""
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let path = (components?.percentEncodedPath.isEmpty == false ? components!.percentEncodedPath : "/") + (components?.percentEncodedQuery.map { "?\($0)" } ?? "")
        let request = "GET \(path) HTTP/1.1\r\nHost: \(hostHeader)\(portHeader)\r\nAccept: text/html,application/json,video/*;q=0.8,*/*;q=0.5\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: ApsidesLinkPreview/1\r\n\r\n"
        try await send(Data(request.utf8), on: connection)
        return try await receive(on: connection)
    }

    private static func connect(_ connection: NWConnection) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let gate = Once()
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        gate.run { continuation.resume() }
                    case .failed(let error):
                        gate.run { continuation.resume(throwing: error) }
                    case .cancelled:
                        gate.run { continuation.resume(throwing: CancellationError()) }
                    default: break
                    }
                }
                connection.start(queue: .global(qos: .userInitiated))
            }
        } onCancel: {
            connection.cancel()
        }
    }

    private static func send(_ data: Data, on connection: NWConnection) async throws {
        let gate = Once()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connection.send(content: data, completion: .contentProcessed { error in
                    gate.run {
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume() }
                    }
                })
            }
        } onCancel: {
            connection.cancel()
        }
    }

    private static func receive(on connection: NWConnection) async throws -> RawResponse {
        let limit = 2 * 1_024 * 1_024
        var data = Data()
        var headerEnd: Range<Data.Index>?
        var responseComplete = false
        while headerEnd == nil {
            try Task.checkCancellation()
            let chunk = try await receiveChunk(on: connection)
            data.append(chunk.data)
            guard data.count <= limit + 64 * 1_024 else { throw Failure.tooLarge }
            headerEnd = data.range(of: Data("\r\n\r\n".utf8))
            responseComplete = chunk.complete
            if responseComplete { break }
        }
        guard let headerEnd else { throw Failure.unsupportedContent }
        let headerData = data[..<headerEnd.lowerBound]
        guard let headerText = String(data: headerData, encoding: .utf8) else { throw Failure.unsupportedContent }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let status = lines.first.flatMap({ $0.split(separator: " ").dropFirst().first }).flatMap({ Int($0) }) else { throw Failure.unsupportedContent }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let separator = line.firstIndex(of: ":") else { continue }
            headers[line[..<separator].lowercased()] = line[line.index(after: separator)...].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let mime = headers["content-type"]?.split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() } ?? ""
        if (200..<300).contains(status), isVideoMIME(mime) {
            return RawResponse(status: status, headers: headers, body: Data())
        }
        let contentLength = headers["content-length"].flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if let contentLength {
            guard contentLength >= 0 else { throw Failure.unsupportedContent }
            guard contentLength <= limit else { throw Failure.tooLarge }
        }
        var body = Data(data[headerEnd.upperBound...])
        if let length = contentLength {
            while body.count < length {
                let chunk = try await receiveChunk(on: connection)
                body.append(chunk.data)
                guard body.count <= length, body.count <= limit else { throw Failure.tooLarge }
                if chunk.complete { break }
            }
            guard body.count >= length else { throw Failure.unsupportedContent }
            body = body.prefix(length)
        } else {
            var complete = responseComplete
            while !complete {
                let chunk = try await receiveChunk(on: connection)
                body.append(chunk.data); complete = chunk.complete
                guard body.count <= limit else { throw Failure.tooLarge }
            }
        }
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            body = try decodeChunked(body)
        }
        return RawResponse(status: status, headers: headers, body: body)
    }

    private static func receiveChunk(on connection: NWConnection) async throws -> (data: Data, complete: Bool) {
        let gate = Once()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, Bool), Error>) in
                connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1_024) { data, _, complete, error in
                    gate.run {
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume(returning: (data ?? Data(), complete)) }
                    }
                }
            }
        } onCancel: {
            connection.cancel()
        }
    }

    private static func decodeChunked(_ data: Data) throws -> Data {
        let marker = Data("\r\n".utf8)
        var offset = data.startIndex
        var output = Data()
        while offset < data.endIndex {
            let remaining = data[offset...]
            guard let end = remaining.range(of: marker),
                  let size = Int(String(decoding: data[offset..<end.lowerBound], as: UTF8.self).split(separator: ";", maxSplits: 1).first ?? "", radix: 16),
                  size >= 0,
                  size <= 2 * 1_024 * 1_024 else {
                throw Failure.unsupportedContent
            }
            offset = end.upperBound
            if size == 0 { return output }
            let available = data.distance(from: offset, to: data.endIndex)
            guard available >= marker.count, size <= available - marker.count else { throw Failure.unsupportedContent }
            output.append(data[offset..<data.index(offset, offsetBy: size)])
            guard output.count <= 2 * 1_024 * 1_024 else { throw Failure.tooLarge }
            offset = data.index(offset, offsetBy: size + marker.count)
        }
        throw Failure.unsupportedContent
    }

    static func parseHTML(_ html: String, baseURL: URL) -> (metadata: LinkMetadata, oEmbedURL: URL?) {
        var fields: [String: String] = [:]
        var oEmbedURL: URL?
        for tag in matches(#"<(meta|link)\b((?:"[^"]*"|'[^']*'|[^'">])*)>"#, in: html) {
            let attributes = attributes(in: tag[2])
            if tag[1].lowercased() == "meta", let key = attributes["property"] ?? attributes["name"],
               let content = attributes["content"], fields[key.lowercased()] == nil {
                fields[key.lowercased()] = content
            } else if tag[1].lowercased() == "link",
                      attributes["type"]?.lowercased() == "application/json+oembed",
                      attributes["rel"]?.lowercased().split(separator: " ").contains("alternate") == true,
                      oEmbedURL == nil {
                oEmbedURL = resolvedURL(attributes["href"], relativeTo: baseURL)
            }
        }
        let titleTag = matches(#"<title\b[^>]*>(.*?)</title>"#, in: html).first?[1]
        let title = fields["og:title"] ?? fields["twitter:title"] ?? titleTag.map(decodeEntities) ?? baseURL.host ?? baseURL.absoluteString
        var metadata = LinkMetadata(
            title: title,
            summary: fields["og:description"] ?? fields["description"] ?? fields["twitter:description"],
            imageURL: resolvedURL(fields["og:image:secure_url"] ?? fields["og:image"] ?? fields["twitter:image"], relativeTo: baseURL)
        )
        let video = fields["og:video:secure_url"] ?? fields["og:video:url"] ?? fields["og:video"]
        if let videoURL = resolvedURL(video, relativeTo: baseURL) {
            let mime = fields["og:video:type"]?.lowercased() ?? ""
            if isVideoMIME(mime) { metadata.playback = .directVideo(videoURL) }
            else if mime == "text/html" || mime.isEmpty { metadata.playback = .embedURL(videoURL) }
        }
        return (metadata, oEmbedURL)
    }

    static func mergeOEmbed(_ data: Data, into original: LinkMetadata, baseURL: URL) throws -> LinkMetadata {
        struct OEmbed: Decodable {
            var type: String
            var title: String?
            var thumbnail_url: String?
            var html: String?
        }
        let embed = try JSONDecoder().decode(OEmbed.self, from: data)
        var metadata = original
        if let title = embed.title, !title.isEmpty { metadata.title = title }
        metadata.imageURL = resolvedURL(embed.thumbnail_url, relativeTo: baseURL) ?? metadata.imageURL
        if ["video", "rich"].contains(embed.type), let html = embed.html {
            // Use a provider-advertised iframe URL, never inject arbitrary oEmbed scripts into our page.
            let frame = matches(#"<iframe\b((?:"[^"]*"|'[^']*'|[^'">])*)>"#, in: html).first
            if let frame, let url = resolvedURL(attributes(in: frame[1])["src"], relativeTo: baseURL) {
                metadata.playback = .embedURL(url)
            } else if metadata.playback == nil {
                metadata.discoveryNote = "This provider did not advertise an iframe player. Open the link to view it."
            }
        }
        return metadata
    }

    private static func isVideoMIME(_ mime: String) -> Bool {
        mime.hasPrefix("video/") || ["application/vnd.apple.mpegurl", "application/x-mpegurl"].contains(mime)
    }

    private static func resolvedURL(_ source: String?, relativeTo base: URL) -> URL? {
        guard let source, let url = URL(string: source, relativeTo: base)?.absoluteURL else { return nil }
        return validatedURL(url.absoluteString)
    }

    private static func attributes(in tag: String) -> [String: String] {
        var result: [String: String] = [:]
        for match in matches(#"([a-z_:][a-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#, in: tag) {
            let value = match.dropFirst(2).first(where: { !$0.isEmpty }) ?? ""
            result[match[1].lowercased()] = decodeEntities(value)
        }
        return result
    }

    private static func matches(_ pattern: String, in string: String) -> [[String]] {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
        let text = string as NSString
        return expression.matches(in: string, range: NSRange(location: 0, length: text.length)).map { match in
            (0..<match.numberOfRanges).map { index in
                let range = match.range(at: index)
                return range.location == NSNotFound ? "" : text.substring(with: range)
            }
        }
    }

    private static func decodeEntities(_ source: String) -> String {
        let entities = ["amp": "&", "quot": "\"", "apos": "'", "lt": "<", "gt": ">", "nbsp": " ", "ndash": "–", "mdash": "—", "hellip": "…"]
        var result = source
        for match in matches(#"&(#x[0-9a-f]+|#[0-9]+|[a-z]+);"#, in: source).reversed() {
            let entity = match[1]
            let replacement: String?
            if entity.lowercased().hasPrefix("#x"), let value = UInt32(entity.dropFirst(2), radix: 16), let scalar = UnicodeScalar(value) {
                replacement = String(scalar)
            } else if entity.hasPrefix("#"), let value = UInt32(entity.dropFirst()), let scalar = UnicodeScalar(value) {
                replacement = String(scalar)
            } else { replacement = entities[entity] }
            if let replacement { result = result.replacingOccurrences(of: match[0], with: replacement) }
        }
        return result
    }
}
