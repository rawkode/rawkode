import Foundation

struct LinkMetadata: Codable, Equatable {
    enum Playback: Codable, Equatable {
        case directVideo(URL)
        case embedURL(URL)
    }

    var title: String
    var summary: String? = nil
    var imageURL: URL? = nil
    var playback: Playback? = nil
    var discoveryNote: String? = nil

    var hasPlayableVideo: Bool { playback != nil }
}
