import Foundation

struct Component: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case diagram, mermaid, drawing, link }
    var id = UUID()
    var kind: Kind
    var title: String
    var source: String = ""
    var svg: String? = nil
    var drawing: DrawingDocument? = nil
    var metadata: LinkMetadata? = nil

    static let diagramSource = """
    direction: right
    idea: Idea {shape: oval}
    note: Native note
    diagram: Diagram
    idea -> note: write
    note -> diagram: visualize
    """
}
