import Foundation

struct LinkMetadata: Codable, Equatable {
    enum Playback: Codable, Equatable {
        case directVideo(URL)
        case embedURL(URL)

        private enum Keys: String, CodingKey { case type, url }
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: Keys.self)
            let url = try container.decode(URL.self, forKey: .url)
            switch try container.decode(String.self, forKey: .type) {
            case "directVideo": self = .directVideo(url)
            case "embedURL": self = .embedURL(url)
            default: throw NoteDocument.DocumentError.unsupportedContent("playback type")
            }
        }
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: Keys.self)
            switch self {
            case .directVideo(let url): try container.encode("directVideo", forKey: .type); try container.encode(url, forKey: .url)
            case .embedURL(let url): try container.encode("embedURL", forKey: .type); try container.encode(url, forKey: .url)
            }
        }
    }

    var title: String
    var summary: String? = nil
    var imageURL: URL? = nil
    var playback: Playback? = nil
    var discoveryNote: String? = nil

    var hasPlayableVideo: Bool { playback != nil }
}
