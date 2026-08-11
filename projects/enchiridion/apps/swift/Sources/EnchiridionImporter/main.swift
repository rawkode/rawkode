// main.swift
// EnchiridionImporter
//
// CLI entry point. See README.md for the full pipeline description and
// exactly how to point this at a real old-app vault / vault worker.
//
//   swift run EnchiridionImporter \
//     --old-vault-db /path/to/old/enchiridion.sqlite \
//     --vault-url wss://your-vault-hostname/sync \
//     --access-client-id <id> --access-client-secret <secret> \
//     [--ledger /path/to/import-ledger.json] \
//     [--supertags-out /path/to/supertags/imported] \
//     [--dry-run]
import EnchiridionCore
import EnchiridionSync
import Foundation

struct CLIOptions {
  var oldVaultDBPath: String?
  var vaultURL: URL?
  var accessClientId: String?
  var accessClientSecret: String?
  var ledgerPath: String?
  var supertagsOutputDirectory: String?
  var dryRun = false

  static func parse(_ arguments: [String]) -> CLIOptions {
    var options = CLIOptions()
    var index = 0
    func value() -> String? {
      guard index + 1 < arguments.count else { return nil }
      index += 1
      return arguments[index]
    }
    while index < arguments.count {
      switch arguments[index] {
      case "--old-vault-db": options.oldVaultDBPath = value()
      case "--vault-url": options.vaultURL = value().flatMap(URL.init(string:))
      case "--access-client-id": options.accessClientId = value()
      case "--access-client-secret": options.accessClientSecret = value()
      case "--ledger": options.ledgerPath = value()
      case "--supertags-out": options.supertagsOutputDirectory = value()
      case "--dry-run": options.dryRun = true
      default: break
      }
      index += 1
    }
    return options
  }
}

func runSupertagGeneration(dbPath: String, outputDirectory: String) throws {
  let source = OldVaultSQLiteSource(path: dbPath)
  let rows = try source.readSupertagSchemas()
  var generated = 0
  for row in rows {
    guard let definition = try? OldSupertagDefinition.decode(from: row.definitionJSON),
      OldSupertagOwnershipResolver.isRuntimeUserCreated(definition, rowDeleted: row.deleted)
    else { continue }
    let slug = SupertagModuleGenerator.slug(forOldSupertagID: definition.id)
    let source = SupertagModuleGenerator.generateModule(from: definition)
    let outputPath = (outputDirectory as NSString).appendingPathComponent("\(slug).ts")
    try source.write(toFile: outputPath, atomically: true, encoding: .utf8)
    print("wrote \(outputPath)")
    generated += 1
  }
  print("generated \(generated) supertag module(s) from \(rows.count) supertag_schemas row(s)")
}

func runPageImport(options: CLIOptions) async throws {
  guard let dbPath = options.oldVaultDBPath else {
    print("--old-vault-db is required for page import")
    return
  }
  let source = OldVaultSQLiteSource(path: dbPath)
  let pages = try source.readPageDocuments()
  print("read \(pages.count) page document(s) from \(dbPath)")

  let ledger = VaultImportLedger(persistencePath: options.ledgerPath.map(URL.init(fileURLWithPath:)))

  let pusher: any VaultPagePushing
  if options.dryRun {
    pusher = RecordingVaultPagePusher()
  } else {
    guard let vaultURL = options.vaultURL else {
      print("--vault-url is required unless --dry-run is passed")
      return
    }
    let clientId = options.accessClientId ?? ""
    let clientSecret = options.accessClientSecret ?? ""
    pusher = await VaultSyncPusher.connect(vaultURL: vaultURL) {
      AccessServiceTokenCredential(clientId: clientId, clientSecret: clientSecret)
    }
  }

  let result = await VaultImporter.importPages(
    oldSnapshots: pages.map(\.document), pusher: pusher, ledger: ledger
  )
  print(
    "import summary: processed=\(result.summary.pagesProcessed) pushed=\(result.summary.pagesPushed) "
      + "skippedUnchanged=\(result.summary.pagesSkippedUnchanged) failures=\(result.failures.count)"
  )
  for failure in result.failures {
    print("  FAILED page \(failure.originalPageID ?? "<unknown>"): \(failure.error)")
  }
  if let recording = pusher as? RecordingVaultPagePusher {
    let pushes = await recording.pushes
    print("dry-run: would have pushed \(pushes.count) page(s):")
    for push in pushes.prefix(20) {
      print("  \(push.pageID.rawValue) (\(push.docType), \(push.documentSnapshot.count) bytes)")
    }
  }
  if let disconnectable = pusher as? VaultSyncPusher {
    await disconnectable.disconnect()
  }
}

let options = CLIOptions.parse(Array(CommandLine.arguments.dropFirst()))

if let dbPath = options.oldVaultDBPath, let outputDirectory = options.supertagsOutputDirectory {
  do {
    try runSupertagGeneration(dbPath: dbPath, outputDirectory: outputDirectory)
  } catch {
    print("supertag generation failed: \(error)")
  }
}

if options.oldVaultDBPath != nil {
  do {
    try await runPageImport(options: options)
  } catch {
    print("page import failed: \(error)")
  }
} else {
  print(
    """
    EnchiridionImporter — migrates an old Enchiridion vault's Automerge pages \
    (and generates TS modules for its runtime user-created supertags) into a \
    new Enchiridion 2 vault. See Sources/EnchiridionImporter/README.md.

    Usage:
      swift run EnchiridionImporter --old-vault-db <path> [--vault-url <wss://...>] \
        [--access-client-id <id> --access-client-secret <secret>] \
        [--ledger <path>] [--supertags-out <dir>] [--dry-run]
    """
  )
}
