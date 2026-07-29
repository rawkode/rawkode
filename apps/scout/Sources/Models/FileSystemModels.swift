import Foundation
import UniformTypeIdentifiers

struct AccessGrant: Codable, Identifiable, Hashable, Sendable {
  let id: UUID
  var displayName: String
  var bookmarkData: Data
  var lastKnownPath: String
  var dateAdded: Date
  var sortOrder: Int
  var requiresSecurityScope: Bool

  init(
    id: UUID = UUID(),
    displayName: String,
    bookmarkData: Data,
    lastKnownPath: String,
    dateAdded: Date = .now,
    sortOrder: Int,
    requiresSecurityScope: Bool = true
  ) {
    self.id = id
    self.displayName = displayName
    self.bookmarkData = bookmarkData
    self.lastKnownPath = lastKnownPath
    self.dateAdded = dateAdded
    self.sortOrder = sortOrder
    self.requiresSecurityScope = requiresSecurityScope
  }
}

struct FileItem: Identifiable, Hashable, Sendable {
  let id: URL
  let url: URL
  let name: String
  let contentTypeIdentifier: String?
  let kindDescription: String
  let fileSize: Int64?
  let creationDate: Date?
  let modificationDate: Date?
  let isDirectory: Bool
  let isPackage: Bool
  let isSymbolicLink: Bool
  let isHidden: Bool
  let isReadable: Bool
  let isWritable: Bool
  let tags: [String]

  var isTraversableDirectory: Bool {
    isDirectory && !isPackage && !isSymbolicLink
  }

  var systemImage: String {
    if isSymbolicLink { return "link" }
    if isDirectory { return isPackage ? "shippingbox" : "folder.fill" }

    guard let contentTypeIdentifier,
          let type = UTType(contentTypeIdentifier)
    else { return "doc" }

    if type.conforms(to: .image) { return "photo" }
    if type.conforms(to: .movie) { return "film" }
    if type.conforms(to: .audio) { return "waveform" }
    if type.conforms(to: .pdf) { return "doc.richtext" }
    if type.conforms(to: .archive) { return "archivebox" }
    if type.conforms(to: .sourceCode) { return "chevron.left.forwardslash.chevron.right" }
    if type.conforms(to: .plainText) { return "doc.text" }
    return "doc"
  }

  var formattedSize: String {
    guard let fileSize, !isDirectory else { return "–" }
    return ByteCountFormatter.string(fromByteCount: fileSize, countStyle: .file)
  }

  var formattedModificationDate: String {
    modificationDate?.formatted(date: .abbreviated, time: .shortened) ?? "–"
  }

  static func from(url: URL, values: URLResourceValues) -> FileItem {
    let type = values.contentType
    let isDirectory = values.isDirectory ?? false
    let isPackage = values.isPackage ?? false
    let isSymbolicLink = values.isSymbolicLink ?? false

    let kindDescription: String
    if isSymbolicLink {
      kindDescription = String(localized: "Alias")
    } else if isDirectory && !isPackage {
      kindDescription = String(localized: "Folder")
    } else {
      kindDescription = type?.localizedDescription ?? String(localized: "Document")
    }

    return FileItem(
      id: url.standardizedFileURL,
      url: url.standardizedFileURL,
      name: values.name ?? url.lastPathComponent,
      contentTypeIdentifier: type?.identifier,
      kindDescription: kindDescription,
      fileSize: values.fileSize.map(Int64.init),
      creationDate: values.creationDate,
      modificationDate: values.contentModificationDate,
      isDirectory: isDirectory,
      isPackage: isPackage,
      isSymbolicLink: isSymbolicLink,
      isHidden: values.isHidden ?? false,
      isReadable: values.isReadable ?? false,
      isWritable: values.isWritable ?? false,
      tags: values.tagNames ?? []
    )
  }
}

struct DirectorySnapshot: Equatable, Sendable {
  let directoryURL: URL
  let rootURL: URL
  let items: [FileItem]
  let loadedAt: Date
}

enum FileSortField: String, Codable, CaseIterable, Sendable {
  case name
  case kind
  case size
  case modified
}

struct FileSort: Codable, Equatable, Sendable {
  var field: FileSortField = .name
  var ascending = true
  var foldersFirst = true
}

enum ConflictResolution: String, Codable, Sendable {
  case stop
  case keepBoth
  case replace
}

struct FileMovePair: Hashable, Sendable {
  let source: URL
  let destination: URL
}

enum FileOperationRequest: Hashable, Sendable {
  case createFolder(parent: URL, name: String)
  case rename(source: URL, name: String, conflict: ConflictResolution)
  case copy(sources: [URL], destination: URL, conflict: ConflictResolution)
  case move(sources: [URL], destination: URL, conflict: ConflictResolution)
  case movePairs([FileMovePair], conflict: ConflictResolution)
  case duplicate(sources: [URL])
  case trash(sources: [URL])
  case setTags(sources: [URL], tags: [String])
  case compress(sources: [URL], destination: URL)
  case extract(archive: URL, destination: URL)
  case removeCreatedItems([URL])

  var title: String {
    switch self {
    case .createFolder: String(localized: "Create Folder")
    case .rename: String(localized: "Rename")
    case .copy: String(localized: "Copy")
    case .move, .movePairs: String(localized: "Move")
    case .duplicate: String(localized: "Duplicate")
    case .trash: String(localized: "Move to Trash")
    case .setTags: String(localized: "Set Tags")
    case .compress: String(localized: "Compress")
    case .extract: String(localized: "Extract")
    case .removeCreatedItems: String(localized: "Undo")
    }
  }
}

struct FileOperationFailure: Equatable, Sendable {
  let url: URL
  let message: String
}

struct FileOperationResult: Sendable {
  let id: UUID
  let title: String
  let completedURLs: [URL]
  let failures: [FileOperationFailure]
  let undoRequest: FileOperationRequest?

  var succeeded: Bool { failures.isEmpty }
}
