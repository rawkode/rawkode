import Foundation

enum LinkMetadataResolver {
    enum Failure: LocalizedError {
        case invalidURL, response(Int), tooLarge, unsupportedContent
        var errorDescription: String? {
            switch self {
            case .invalidURL: return "Enter an http or https URL without a username or password."
            case .response(let code): return "The website returned HTTP \(code)."
            case .tooLarge: return "The metadata response exceeds the 2 MB limit."
            case .unsupportedContent: return "This link does not provide a web page or supported video."
            }
        }
    }

    static func validatedURL(_ source: String) -> URL? {
        guard let url = URL(string: source.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }

    static func resolve(_ source: String) async throws -> LinkMetadata {
        guard let url = validatedURL(source) else { throw Failure.invalidURL }
        let page = try await fetch(url)
        if isVideoMIME(page.mime) {
            return LinkMetadata(title: page.url.lastPathComponent, playback: .directVideo(page.url))
        }
        guard page.mime.contains("html") || page.mime.isEmpty else { throw Failure.unsupportedContent }
        let html = String(data: page.data, encoding: .utf8) ?? String(decoding: page.data, as: UTF8.self)
        let parsed = parseHTML(html, baseURL: page.url)
        var metadata = parsed.metadata
        if let endpoint = parsed.oEmbedURL {
            do {
                let response = try await fetch(endpoint)
                metadata = try mergeOEmbed(response.data, into: metadata, baseURL: response.url)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                metadata.discoveryNote = "Player metadata could not be loaded: \(error.localizedDescription)"
            }
        }
        return metadata
    }

    private struct Response {
        var data: Data
        var url: URL
        var mime: String
    }

    private static func fetch(_ url: URL) async throws -> Response {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("text/html,application/json,video/*;q=0.8,*/*;q=0.5", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.unsupportedContent }
        guard (200..<300).contains(http.statusCode) else { throw Failure.response(http.statusCode) }
        guard let finalURL = http.url, validatedURL(finalURL.absoluteString) != nil else { throw Failure.invalidURL }
        let mime = http.mimeType?.lowercased() ?? ""
        // Streaming response headers identify a direct video without downloading it.
        if isVideoMIME(mime) { return Response(data: Data(), url: finalURL, mime: mime) }
        let limit = 2 * 1_024 * 1_024
        guard http.expectedContentLength <= limit else { throw Failure.tooLarge }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < limit else { throw Failure.tooLarge }
            data.append(byte)
        }
        return Response(data: data, url: finalURL, mime: mime)
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
