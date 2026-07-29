import Foundation
import Observation

@MainActor
@Observable
final class ScoutAppModel {
  let grantStore: AccessGrantStore
  let scopeBroker: SecurityScopeBroker
  let fileSystem: any FileSystemClient
  let workspace: any WorkspaceClient
  let archive: any ArchiveClient

  init(
    grantStore: AccessGrantStore? = nil,
    scopeBroker: SecurityScopeBroker = SecurityScopeBroker(),
    fileSystem: any FileSystemClient = LocalFileSystemClient(),
    workspace: any WorkspaceClient = SystemWorkspaceClient(),
    archive: any ArchiveClient = ZIPArchiveClient()
  ) {
    self.grantStore = grantStore ?? AccessGrantStore()
    self.scopeBroker = scopeBroker
    self.fileSystem = fileSystem
    self.workspace = workspace
    self.archive = archive
  }

  func makeSession() -> BrowserSession {
    BrowserSession(
      grantStore: grantStore,
      scopeBroker: scopeBroker,
      fileSystem: fileSystem,
      search: SpotlightSearchClient(),
      workspace: workspace,
      journal: OperationJournal(fileSystem: fileSystem, workspace: workspace, archive: archive)
    )
  }
}
