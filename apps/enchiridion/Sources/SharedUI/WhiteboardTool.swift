import SwiftUI

enum WhiteboardTool: String, CaseIterable, Identifiable {
  case select
  case hand
  case pen
  case rectangle
  case ellipse
  case diamond
  case text
  case sticky
  case arrow

  var id: Self { self }

  var title: String {
    switch self {
    case .select: "Select"
    case .hand: "Hand"
    case .pen: "Draw"
    case .rectangle: "Rectangle"
    case .ellipse: "Ellipse"
    case .diamond: "Diamond"
    case .text: "Text"
    case .sticky: "Note"
    case .arrow: "Arrow"
    }
  }

  var systemImage: String {
    switch self {
    case .select: "cursorarrow"
    case .hand: "hand.draw"
    case .pen: "pencil.tip"
    case .rectangle: "rectangle"
    case .ellipse: "circle"
    case .diamond: "diamond"
    case .text: "textformat"
    case .sticky: "note.text"
    case .arrow: "arrow.up.right"
    }
  }

  var key: KeyEquivalent {
    switch self {
    case .select: "v"
    case .hand: "h"
    case .pen: "p"
    case .rectangle: "r"
    case .ellipse: "o"
    case .diamond: "d"
    case .text: "x"
    case .sticky: "t"
    case .arrow: "a"
    }
  }

  var keyLabel: String {
    switch self {
    case .select: "V"
    case .hand: "H"
    case .pen: "P"
    case .rectangle: "R"
    case .ellipse: "O"
    case .diamond: "D"
    case .text: "X"
    case .sticky: "T"
    case .arrow: "A"
    }
  }

  var help: String {
    switch self {
    case .select: "Select and move elements"
    case .hand: "Pan the canvas"
    case .pen: "Draw a freehand line"
    case .rectangle: "Draw a rectangle"
    case .ellipse: "Draw an ellipse"
    case .diamond: "Draw a diamond"
    case .text: "Add plain text"
    case .sticky: "Add a text note"
    case .arrow: "Connect two points or elements"
    }
  }
}
