// Generated TypeScript definitions for DHD
// This file provides global type definitions for dhd modules

declare global {
  // Type definitions
  interface ModuleBuilder {


      description(desc: string): this;
      tags(tags: string[]): this;
      tag(tag: string): this;
      dependsOn(dependencies: string[]): this;
      actions(actions: ActionType[]): ModuleDefinition
  }

  interface ModuleDefinition {
    name: string;
    description?: string | undefined;
    tags: string[];
    dependencies: string[];
    actions: ActionType[]
}

  interface LinkDirectory {
    source: string;
    target: string;
    force: boolean
}

  interface DconfImport {
    source: string;
    path: string
}

  interface CopyFile {
    source: string;
    target: string;
    escalate: boolean
}

  interface LinkFile {
    source: string;
    target: string;
    force: boolean
}

  type Condition = 
    | { type: "FileExists" }
    | { type: "DirectoryExists" }
    | { type: "CommandSucceeds" }
    | { type: "EnvironmentVariable" }
    | { type: "AllOf" }
    | { type: "AnyOf" }
    | { type: "Not" };

  type ActionType = 
    | { type: "PackageInstall" } & PackageInstall
    | { type: "LinkFile" } & LinkFile
    | { type: "LinkDirectory" } & LinkDirectory
    | { type: "ExecuteCommand" } & ExecuteCommand
    | { type: "CopyFile" } & CopyFile
    | { type: "Directory" } & Directory
    | { type: "HttpDownload" } & HttpDownload
    | { type: "SystemdSocket" } & SystemdSocket
    | { type: "SystemdService" } & SystemdService
    | { type: "Conditional" } & ConditionalAction
    | { type: "DconfImport" } & DconfImport
    | { type: "InstallGnomeExtensions" } & InstallGnomeExtensions
    | { type: "PackageRemove" } & PackageRemove
    | { type: "SystemdManage" } & SystemdManage
    | { type: "GitConfig" } & GitConfig;

  interface SystemdSocket {
    name: string;
    description: string;
    listenStream: string;
    scope: string
}

  interface SystemdService {
    name: string;
    description: string;
    execStart: string;
    serviceType: string;
    scope: string;
    restart?: string | undefined;
    restartSec?: number | undefined
}

  interface HttpDownload {
    url: string;
    destination: string;
    checksum?: Checksum | undefined;
    mode?: number | undefined
}

  interface Checksum {
    algorithm: string;
    value: string
}

  interface PackageInstallConfig {
    names: PlatformSelect;
    manager?: PackageManagerType | undefined;
    module?: string | undefined
}

  interface InstallGnomeExtensions {
    extensions: string[]
}

  interface ExecuteCommand {
    shell?: string | undefined;
    command: string;
    args?: string[] | undefined;
    escalate: boolean
}

  interface ConditionalAction {
    action: Box;
    conditions: Condition[];
    skipOnSuccess: boolean
}

  type PackageManager = 
    | "Apt"
    | "Brew"
    | "Bun"
    | "Cargo"
    | "Dnf"
    | "Flatpak"
    | "Npm"
    | "Pacman"
    | "Snap"
    | "Go"
    | "Yum"
    | "Zypper"
    | "Pip"
    | "Gem"
    | "Nix";

  interface SystemdManage {
    name: string;
    operation: string;
    scope: string
}

  interface PackageRemove {
    names: string[];
    manager?: PackageManager | undefined
}

  interface Directory {
    path: string;
    escalate?: boolean | undefined
}

  interface PackageInstall {
    names: string[];
    manager?: PackageManager | undefined
}

  interface GitConfig {
    entries: GitConfigEntry[];
    global?: boolean | undefined;
    system?: boolean | undefined;
    unset?: boolean | undefined
}

  interface GitConfigEntry {
    key: string;
    value: string;
    add?: boolean | undefined
}

  // Helper function signatures
  function defineModule(name: string): ModuleBuilder;
  function linkDirectory(config: LinkDirectory): ActionType;
  function dconfImport(config: DconfImport): ActionType;
  function copyFile(config: CopyFile): ActionType;
  function linkFile(config: LinkFile): ActionType;
  function not(condition: Condition): Condition;
  function anyOf(conditions: Condition[]): Condition;
  function allOf(conditions: Condition[]): Condition;
  function envVar(name: string, value: string | undefined): Condition;
  function commandSucceeds(command: string, args: string[] | undefined): Condition;
  function directoryExists(path: string): Condition;
  function fileExists(path: string): Condition;
  function systemdSocket(config: SystemdSocket): ActionType;
  function systemdService(config: SystemdService): ActionType;
  function httpDownload(config: HttpDownload): ActionType;
  function packageInstall(config: PackageInstallConfig): Box;
  function installGnomeExtensions(config: InstallGnomeExtensions): ActionType;
  function executeCommand(config: ExecuteCommand): ActionType;
  function onlyIf(action: ActionType, conditions: Condition[]): ActionType;
  function skipIf(action: ActionType, conditions: Condition[]): ActionType;
  function systemdManage(config: SystemdManage): ActionType;
  function packageRemove(config: PackageRemove): ActionType;
  function directory(config: Directory): ActionType;
  function packageInstall(config: PackageInstall): ActionType;
  function gitConfig(config: GitConfig): ActionType;

}

export {};
