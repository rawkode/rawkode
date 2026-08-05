import Foundation
import Testing

struct ShareExtensionActivationTests {
  private static let expectedRuleKeys: Set<String> = [
    "NSExtensionActivationDictionaryVersion",
    "NSExtensionActivationSupportsText",
    "NSExtensionActivationSupportsWebURLWithMaxCount",
  ]

  @Test(arguments: [
    ("EnchiridionTaskShare", "Configuration/EnchiridionTaskShare-Info.plist"),
    ("EnchiridionMacTaskShare", "Configuration/EnchiridionMacTaskShare-Info.plist"),
  ])
  func generatedShareExtensionMetadataHasTheExactVersionTwoRule(
    target: String,
    plistPath: String
  ) throws {
    let plist = try PropertyListSerialization.propertyList(
      from: Data(contentsOf: appRoot.appendingPathComponent(plistPath)),
      options: [],
      format: nil
    )
    let root = try #require(plist as? [String: Any])
    let extensionDictionary = try #require(root["NSExtension"] as? [String: Any])
    let attributes = try #require(extensionDictionary["NSExtensionAttributes"] as? [String: Any])
    let activationRule = try #require(attributes["NSExtensionActivationRule"] as? [String: Any])

    #expect(Set(activationRule.keys) == Self.expectedRuleKeys)
    #expect(activationRule["NSExtensionActivationDictionaryVersion"] as? Int == 2)
    #expect(activationRule["NSExtensionActivationSupportsText"] as? Bool == true)
    #expect(activationRule["NSExtensionActivationSupportsWebURLWithMaxCount"] as? Int == 12)

    let projectRule = try projectActivationRule(for: target)
    #expect(projectRule == [
      "NSExtensionActivationDictionaryVersion: 2",
      "NSExtensionActivationSupportsText: true",
      "NSExtensionActivationSupportsWebURLWithMaxCount: 12",
    ])
  }

  private var appRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private func projectActivationRule(for target: String) throws -> [String] {
    let lines = try String(
      contentsOf: appRoot.appendingPathComponent("project.yml"),
      encoding: .utf8
    ).components(separatedBy: .newlines)
    let targetHeader = "  \(target):"
    let targetStart = try #require(lines.firstIndex(of: targetHeader))
    let targetEnd = lines[(targetStart + 1)...].firstIndex { line in
      line.hasPrefix("  ") && !line.hasPrefix("    ") && line.hasSuffix(":")
    } ?? lines.endIndex
    let targetLines = lines[targetStart..<targetEnd]
    let ruleStart = try #require(targetLines.firstIndex { $0.trimmingCharacters(in: .whitespaces) == "NSExtensionActivationRule:" })
    let ruleIndent = targetLines[ruleStart].prefix { $0 == " " }.count
    let ruleLines = targetLines[(ruleStart + 1)...].prefix { line in
      let indentation = line.prefix { $0 == " " }.count
      return line.trimmingCharacters(in: .whitespaces).isEmpty || indentation > ruleIndent
    }

    return ruleLines.compactMap { line in
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      return trimmed.hasPrefix("NSExtensionActivation") ? trimmed : nil
    }
  }
}
