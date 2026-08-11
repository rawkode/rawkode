// GENERATED — DO NOT EDIT BY HAND.
//
// Produced by `packages/codegen`'s `generateSwiftSchema()` (packages/codegen/src/index.ts).
// Regenerate with:
//
//   bun run --cwd packages/codegen generate
//
// Shared generic get/set helpers over `PageObjectMetadata.properties`, used by every
// generated `<Tag>Fields` accessor struct (see `<Module>Supertags.swift`). This file's
// content is the same regardless of which supertag modules are registered — it is
// emitted once per codegen run, not per module.

import EnchiridionCore
import Foundation

public enum SupertagFieldStorage {
  private static func key(_ tagID: SupertagID, _ fieldID: SupertagFieldID) -> SupertagPropertyKey {
    SupertagPropertyKey(supertagID: tagID, fieldID: fieldID)
  }

  private static func setSingle(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: SupertagValue?
  ) {
    let propertyKey = key(tagID, fieldID)
    if let value {
      metadata.properties[propertyKey] = [value]
    } else {
      metadata.properties[propertyKey] = nil
    }
  }

  private static func setArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [SupertagValue]
  ) {
    let propertyKey = key(tagID, fieldID)
    metadata.properties[propertyKey] = values.isEmpty ? nil : values
  }

  public static func readText(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> String? {
    guard case .text(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeText(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: String?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .text($0) })
  }

  public static func readTextArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [String] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .text(let value) = $0 { value } else { nil }
    }
  }

  public static func writeTextArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [String]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .text($0) })
  }

  public static func readNumber(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> Double? {
    guard case .number(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeNumber(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: Double?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .number($0) })
  }

  public static func readNumberArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [Double] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .number(let value) = $0 { value } else { nil }
    }
  }

  public static func writeNumberArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [Double]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .number($0) })
  }

  public static func readBoolean(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> Bool? {
    guard case .boolean(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeBoolean(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: Bool?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .boolean($0) })
  }

  public static func readBooleanArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [Bool] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .boolean(let value) = $0 { value } else { nil }
    }
  }

  public static func writeBooleanArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [Bool]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .boolean($0) })
  }

  public static func readDate(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> Date? {
    guard case .date(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeDate(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: Date?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .date($0) })
  }

  public static func readDateArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [Date] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .date(let value) = $0 { value } else { nil }
    }
  }

  public static func writeDateArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [Date]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .date($0) })
  }

  public static func readDateTime(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> Date? {
    guard case .dateTime(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeDateTime(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: Date?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .dateTime($0) })
  }

  public static func readDateTimeArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [Date] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .dateTime(let value) = $0 { value } else { nil }
    }
  }

  public static func writeDateTimeArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [Date]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .dateTime($0) })
  }

  public static func readURL(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> String? {
    guard case .url(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeURL(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: String?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .url($0) })
  }

  public static func readURLArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [String] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .url(let value) = $0 { value } else { nil }
    }
  }

  public static func writeURLArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [String]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .url($0) })
  }

  public static func readEmail(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> String? {
    guard case .email(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writeEmail(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: String?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .email($0) })
  }

  public static func readEmailArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [String] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .email(let value) = $0 { value } else { nil }
    }
  }

  public static func writeEmailArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [String]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .email($0) })
  }

  public static func readPhone(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> String? {
    guard case .phone(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writePhone(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: String?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .phone($0) })
  }

  public static func readPhoneArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [String] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .phone(let value) = $0 { value } else { nil }
    }
  }

  public static func writePhoneArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [String]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .phone($0) })
  }

  public static func readPage(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> PageID? {
    guard case .page(let value)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return value
  }

  public static func writePage(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: PageID?
  ) {
    setSingle(&metadata, tagID, fieldID, value.map { .page($0) })
  }

  public static func readPageArray(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [PageID] {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .page(let value) = $0 { value } else { nil }
    }
  }

  public static func writePageArray(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [PageID]
  ) {
    setArray(&metadata, tagID, fieldID, values.map { .page($0) })
  }

  public static func readSelect<T: RawRepresentable>(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> T? where T.RawValue == String {
    guard case .select(let raw)? = metadata.properties[key(tagID, fieldID)]?.first else { return nil }
    return T(rawValue: raw)
  }

  public static func writeSelect<T: RawRepresentable>(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ value: T?
  ) where T.RawValue == String {
    setSingle(&metadata, tagID, fieldID, value.map { .select($0.rawValue) })
  }

  public static func readSelectArray<T: RawRepresentable>(
    _ metadata: PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID
  ) -> [T] where T.RawValue == String {
    (metadata.properties[key(tagID, fieldID)] ?? []).compactMap {
      if case .select(let raw) = $0 { T(rawValue: raw) } else { nil }
    }
  }

  public static func writeSelectArray<T: RawRepresentable>(
    _ metadata: inout PageObjectMetadata, _ tagID: SupertagID, _ fieldID: SupertagFieldID,
    _ values: [T]
  ) where T.RawValue == String {
    setArray(&metadata, tagID, fieldID, values.map { .select($0.rawValue) })
  }
}
