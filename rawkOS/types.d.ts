// Generated TypeScript definitions for DHD
// This file provides global type definitions for dhd modules

declare global {
  // Type definitions
  interface PackageRemove {
    names: string[];
    manager?: PackageManager | undefined
}

  interface ExecuteCommand {
    shell?: string | undefined;
    command: string;
    args?: string[] | undefined;
    escalate: boolean
}

  interface SystemdManage {
    name: string;
    operation: string;
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

  interface PackageInstall {
    names: string[];
    manager?: PackageManager | undefined
}

  interface Directory {
    path: string;
    escalate?: boolean | undefined
}

  interface CommandBuilder {
    command: string
;

      succeeds(): Condition;
      exists(): Condition;
      contains(text: string, case_insensitive: boolean): Condition
  }

  interface PropertyBuilder {
    path: string
;

      equals(value: Value): Condition;
      notEquals(value: Value): Condition;
      contains(value: string): Condition;
      isTrue(): Condition;
      isFalse(): Condition
  }

  type ComparisonOperator = 
    | "Equals"
    | "NotEquals"
    | "Contains"
    | "GreaterThan"
    | "LessThan";

  type Condition = 
    | { type: "FileExists" }
    | { type: "DirectoryExists" }
    | { type: "CommandSucceeds" }
    | { type: "EnvironmentVariable" }
    | { type: "SystemProperty" }
    | { type: "CommandExists" }
    | { type: "AllOf" }
    | { type: "AnyOf" }
    | { type: "Not" };

  interface LinkFile {
    source: string;
    target: string;
    force: boolean
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

  interface DconfImport {
    source: string;
    path: string
}

  interface SystemdSocket {
    name: string;
    description: string;
    listenStream: string;
    scope: string
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

  interface InstallGnomeExtensions {
    extensions: string[]
}

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

  interface PackageInstallConfig {
    names: PlatformSelect;
    manager?: PackageManagerType | undefined;
    module?: string | undefined
}

  interface ConditionalAction {
    action: Box;
    conditions: Condition[];
    skipOnSuccess: boolean
}

  interface UserInfo {
    name: string;
    shell: string;
    home: string
}

  interface AuthInfo {
    authType: string;
    method: string
}

  interface HardwareInfo {
    fingerprint: boolean;
    tpm: boolean;
    gpuVendor: string
}

  interface OsInfo {
    family: string;
    distro: string;
    version: string;
    codename: string
}

  interface SystemInfo {
    os: OsInfo;
    hardware: HardwareInfo;
    auth: AuthInfo;
    user: UserInfo
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

  interface ModuleBuilder {


      description(desc: string): this;
      tags(tags: string[]): this;
      tag(tag: string): this;
      dependsOn(dependencies: string[]): this;
      when(condition: Condition): this;
      actions(actions: ActionType[]): ModuleDefinition
  }

  interface ModuleDefinition {
    name: string;
    description?: string | undefined;
    tags: string[];
    dependencies: string[];
    when?: Condition | undefined;
    actions: ActionType[]
}

  interface LinkDirectory {
    source: string;
    target: string;
    force: boolean
}

  interface CopyFile {
    source: string;
    target: string;
    escalate: boolean
}

  // Utility type for extracting property paths from nested objects
  type Paths<T, P extends string = ""> = T extends object ? {
    [K in keyof T]: K extends string ?
      T[K] extends object ? Paths<T[K], `${P}${P extends "" ? "" : "."}${K}`> : `${P}${P extends "" ? "" : "."}${K}`
      : never
  }[keyof T] : never;

  // All valid property paths for SystemInfo
  type SystemInfoPaths = Paths<SystemInfo>;

  // Helper function signatures
  function packageRemove(config: PackageRemove): ActionType;
  function executeCommand(config: ExecuteCommand): ActionType;
  function systemdManage(config: SystemdManage): ActionType;
  function systemdService(config: SystemdService): ActionType;
  function packageInstall(config: PackageInstall): ActionType;
  function directory(config: Directory): ActionType;
  function and(conditions: Condition[]): Condition;
  function or(conditions: Condition[]): Condition;
  function command(cmd: string): CommandBuilder;
  function property(path: SystemInfoPaths): PropertyBuilder;
  function property(path: string): PropertyBuilder;
  function commandExists(command: string): Condition;
  function not(condition: Condition): Condition;
  function anyOf(conditions: Condition[]): Condition;
  function allOf(conditions: Condition[]): Condition;
  function envVar(name: string, value: string | undefined): Condition;
  function commandSucceeds(command: string, args: string[] | undefined): Condition;
  function directoryExists(path: string): Condition;
  function fileExists(path: string): Condition;
  function linkFile(config: LinkFile): ActionType;
  function httpDownload(config: HttpDownload): ActionType;
  function dconfImport(config: DconfImport): ActionType;
  function systemdSocket(config: SystemdSocket): ActionType;
  function gitConfig(config: GitConfig): ActionType;
  function installGnomeExtensions(config: InstallGnomeExtensions): ActionType;
  function packageInstall(config: PackageInstallConfig): Box;
  function onlyIf(action: ActionType, conditions: Condition[]): ActionType;
  function skipIf(action: ActionType, conditions: Condition[]): ActionType;
  function defineModule(name: string): ModuleBuilder;
  function linkDirectory(config: LinkDirectory): ActionType;
  function copyFile(config: CopyFile): ActionType;

}

export {};
