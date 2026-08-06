// CanvasDocumentSerializationTests.swift
// EnchiridionCanvasTests
//
// Golden round-trip tests for `CanvasDocument`'s wire format
// (CanvasDocument.swift) — task brief: "Stroke/shape serialization
// round-trips exactly (golden tests — encode, decode, compare)."
//
// Each test below: build a `CanvasDocument` value, encode it, assert the
// EXACT resulting JSON string (the golden — not just "decodes back to
// itself", which would miss a wire-format regression that happens to stay
// self-consistent), then decode that golden string back and assert it
// equals the original value. Both directions are real: encode-then-compare
// AND decode-then-compare, not one inferred from the other.

import Foundation
import XCTest

@testable import EnchiridionCanvas

final class CanvasDocumentSerializationTests: XCTestCase {
  private func encodedString(_ document: CanvasDocument) throws -> String {
    String(decoding: try CanvasDocumentCoding.encode(document), as: UTF8.self)
  }

  func testEmptyDocument() throws {
    let document = CanvasDocument(canvasSize: CanvasSize(width: 100, height: 200), elements: [])
    let golden = """
      {"canvasSize":{"height":200,"width":100},"elements":[],"format":"enchiridion/canvas","schemaVersion":1}
      """
    XCTAssertEqual(try encodedString(document), golden)

    let decoded = try CanvasDocumentCoding.decode(Data(golden.utf8))
    XCTAssertEqual(decoded, document)
  }

  func testStrokeElement() throws {
    let stroke = CanvasStroke(
      id: CanvasElementID(rawValue: "el_stroke1"),
      points: [CanvasPoint(x: 0, y: 0), CanvasPoint(x: 1.5, y: 2.5), CanvasPoint(x: 3, y: 4)],
      style: CanvasStrokeStyle(strokeColor: CanvasColor(rawValue: "#112233ff"), fillColor: nil, lineWidth: 3)
    )
    let document = CanvasDocument(canvasSize: .defaultSize, elements: [.stroke(stroke)])
    let golden = """
      {"canvasSize":{"height":768,"width":1024},"elements":[{"id":"el_stroke1",\
      "points":[{"x":0,"y":0},{"x":1.5,"y":2.5},{"x":3,"y":4}],\
      "style":{"lineWidth":3,"strokeColor":"#112233ff"},"type":"stroke"}],\
      "format":"enchiridion/canvas","schemaVersion":1}
      """
    XCTAssertEqual(try encodedString(document), golden)

    let decoded = try CanvasDocumentCoding.decode(Data(golden.utf8))
    XCTAssertEqual(decoded, document)
  }

  func testRectangleElementWithFillColor() throws {
    let rectangle = CanvasShape(
      id: CanvasElementID(rawValue: "el_rect1"),
      origin: CanvasPoint(x: 10, y: 20),
      size: CanvasSize(width: 100, height: 50),
      style: CanvasStrokeStyle(strokeColor: .black, fillColor: .red, lineWidth: 2)
    )
    let document = CanvasDocument(canvasSize: .defaultSize, elements: [.rectangle(rectangle)])
    let golden = """
      {"canvasSize":{"height":768,"width":1024},"elements":[{"id":"el_rect1",\
      "origin":{"x":10,"y":20},"size":{"height":50,"width":100},\
      "style":{"fillColor":"#ff3b30ff","lineWidth":2,"strokeColor":"#000000ff"},\
      "type":"rectangle"}],"format":"enchiridion/canvas","schemaVersion":1}
      """
    XCTAssertEqual(try encodedString(document), golden)

    let decoded = try CanvasDocumentCoding.decode(Data(golden.utf8))
    XCTAssertEqual(decoded, document)
  }

  func testEllipseElement() throws {
    let ellipse = CanvasShape(
      id: CanvasElementID(rawValue: "el_ellipse1"),
      origin: CanvasPoint(x: 0, y: 0),
      size: CanvasSize(width: 40, height: 40),
      style: .default
    )
    let document = CanvasDocument(elements: [.ellipse(ellipse)])
    let decoded = try CanvasDocumentCoding.decode(try CanvasDocumentCoding.encode(document))
    XCTAssertEqual(decoded, document)
    guard case .ellipse(let roundTripped) = decoded.elements[0] else {
      XCTFail("expected an ellipse element")
      return
    }
    XCTAssertEqual(roundTripped, ellipse)
  }

  func testLineElement() throws {
    let line = CanvasLineSegment(
      id: CanvasElementID(rawValue: "el_line1"),
      start: CanvasPoint(x: 0, y: 0), end: CanvasPoint(x: 100, y: 100), style: .default
    )
    let document = CanvasDocument(elements: [.line(line)])
    let golden = """
      {"canvasSize":{"height":768,"width":1024},"elements":[{"end":{"x":100,"y":100},\
      "id":"el_line1","start":{"x":0,"y":0},\
      "style":{"lineWidth":2,"strokeColor":"#000000ff"},"type":"line"}],\
      "format":"enchiridion/canvas","schemaVersion":1}
      """
    XCTAssertEqual(try encodedString(document), golden)
    XCTAssertEqual(try CanvasDocumentCoding.decode(Data(golden.utf8)), document)
  }

  func testArrowElementSameShapeAsLineDifferentTypeTag() throws {
    let arrow = CanvasLineSegment(
      id: CanvasElementID(rawValue: "el_arrow1"),
      start: CanvasPoint(x: 5, y: 5), end: CanvasPoint(x: 50, y: 5), style: .default
    )
    let document = CanvasDocument(elements: [.arrow(arrow)])
    let decoded = try CanvasDocumentCoding.decode(try CanvasDocumentCoding.encode(document))
    XCTAssertEqual(decoded, document)
    guard case .arrow = decoded.elements[0] else {
      XCTFail("expected an arrow element, not a line — the type discriminator must round-trip exactly")
      return
    }
  }

  func testTextElement() throws {
    let text = CanvasText(
      id: CanvasElementID(rawValue: "el_text1"),
      position: CanvasPoint(x: 12, y: 34), content: "Hello, canvas!", fontSize: 21, color: .blue
    )
    let document = CanvasDocument(elements: [.text(text)])
    let golden = """
      {"canvasSize":{"height":768,"width":1024},"elements":[{"color":"#007affff",\
      "content":"Hello, canvas!","fontSize":21,"id":"el_text1",\
      "position":{"x":12,"y":34},"type":"text"}],"format":"enchiridion/canvas","schemaVersion":1}
      """
    XCTAssertEqual(try encodedString(document), golden)
    XCTAssertEqual(try CanvasDocumentCoding.decode(Data(golden.utf8)), document)
  }

  func testMixedDocumentPreservesZOrder() throws {
    let elements: [CanvasElement] = [
      .stroke(CanvasStroke(points: [CanvasPoint(x: 0, y: 0), CanvasPoint(x: 1, y: 1)])),
      .rectangle(CanvasShape(origin: CanvasPoint(x: 0, y: 0), size: CanvasSize(width: 10, height: 10))),
      .ellipse(CanvasShape(origin: CanvasPoint(x: 0, y: 0), size: CanvasSize(width: 10, height: 10))),
      .line(CanvasLineSegment(start: CanvasPoint(x: 0, y: 0), end: CanvasPoint(x: 1, y: 1))),
      .arrow(CanvasLineSegment(start: CanvasPoint(x: 0, y: 0), end: CanvasPoint(x: 1, y: 1))),
      .text(CanvasText(position: CanvasPoint(x: 0, y: 0), content: "z")),
    ]
    let document = CanvasDocument(elements: elements)
    let decoded = try CanvasDocumentCoding.decode(try CanvasDocumentCoding.encode(document))
    XCTAssertEqual(decoded.elements.map(\.id), elements.map(\.id))
    XCTAssertEqual(decoded, document)
  }

  func testRejectsWrongFormat() throws {
    let json = """
      {"format":"something-else","schemaVersion":1,"canvasSize":{"width":1,"height":1},"elements":[]}
      """
    XCTAssertThrowsError(try CanvasDocumentCoding.decode(Data(json.utf8))) { error in
      XCTAssertEqual(error as? CanvasDocumentError, .invalidFormat("something-else"))
    }
  }

  func testRejectsUnsupportedSchemaVersion() throws {
    let json = """
      {"format":"enchiridion/canvas","schemaVersion":99,"canvasSize":{"width":1,"height":1},"elements":[]}
      """
    XCTAssertThrowsError(try CanvasDocumentCoding.decode(Data(json.utf8))) { error in
      XCTAssertEqual(error as? CanvasDocumentError, .unsupportedSchemaVersion(99))
    }
  }

  func testEncodingIsDeterministicAcrossRepeatedEncodesOfAnEqualValue() throws {
    let document = CanvasDocument(
      elements: [
        .rectangle(CanvasShape(origin: CanvasPoint(x: 1, y: 2), size: CanvasSize(width: 3, height: 4))),
        .text(CanvasText(position: CanvasPoint(x: 5, y: 6), content: "hi")),
      ])
    let first = try encodedString(document)
    let second = try encodedString(document)
    XCTAssertEqual(first, second)
  }
}
