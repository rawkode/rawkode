import AppKit

/// The serializable document boundary. Views and text-system objects never cross it.
struct NoteDocument: Codable, Equatable {
    var version = 1
    var segments: [Segment]

    enum Segment: Codable, Equatable {
        case richText(Data)
        case component(Component)
        case code(language: String, source: String)
    }

    @MainActor
    init(attributedString: NSAttributedString) throws {
        segments = []
        var failure: Error?
        var position = 0
        while position < attributedString.length {
            do {
                var range = NSRange()
                let attributes = attributedString.attributes(at: position, effectiveRange: &range)
                let value = attributes[.attachment]
                if let attachment = value as? ComponentAttachment {
                    segments.append(.component(attachment.component))
                } else if let language = attributes[.codeLanguage] as? String {
                    segments.append(.code(language: language, source: attributedString.attributedSubstring(from: range).string))
                } else {
                    let part = attributedString.attributedSubstring(from: range)
                    let data = try part.data(from: NSRange(location: 0, length: part.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd])
                    segments.append(.richText(data))
                }
                position = NSMaxRange(range)
            } catch { failure = error; break }
        }
        if let failure { throw failure }
    }

    @MainActor
    func attributedString() throws -> NSAttributedString {
        guard version == 1 else { throw CocoaError(.fileReadInapplicableStringEncoding) }
        let result = NSMutableAttributedString(string: "")
        for segment in segments {
            switch segment {
            case .richText(let data):
                var options: [NSAttributedString.DocumentReadingOptionKey: Any] = [.documentType: NSAttributedString.DocumentType.rtfd]
                if #available(macOS 15, *) { options[.textKit1ListMarkerFormatDocumentOption] = true }
                result.append(try NSAttributedString(data: data, options: options, documentAttributes: nil))
            case .component(let component):
                result.append(NSAttributedString(attachment: ComponentAttachment(component)))
            case .code(let language, let source):
                result.append(CodeBlockStyle.attributed(source, language: language))
            }
        }
        return result
    }
}
