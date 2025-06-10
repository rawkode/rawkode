// Generated TypeScript definitions for DHD
// This file provides global type definitions for dhd modules

declare global {
  // Type definitions
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
      depends(dependency: string): this;
      actions(actions: ActionType[]): ModuleDefinition
  }

  interface ModuleDefinition {
    name: string;
    description?: string | undefined;
    tags: string[];
    dependencies: string[];
    actions: ActionType[]
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

  interface Directory {
    path: string;
    requires_privilege_escalation?: boolean | undefined
}

  interface CopyFile {
    source: string;
    destination: string;
    requires_privilege_escalation: boolean
}

  interface LinkDirectory {
    from: string;
    to: string;
    force: boolean
}

  interface LinkDotfile {
    from: string;
    to: string;
    force: boolean
}

  interface SystemdService {
    name: string;
    description: string;
    exec_start: string;
    service_type: string;
    scope: string;
    restart?: string | undefined;
    restart_sec?: number | undefined
}

  interface ExecuteCommand {
    shell?: string | undefined;
    command: string;
    args?: string[] | undefined;
    escalate: boolean
}

  interface PackageInstallConfig {
    names: PlatformSelect;
    manager?: PackageManagerType | undefined;
    module?: string | undefined
}

  interface SystemdSocket {
    name: string;
    description: string;
    listen_stream: string;
    scope: string
}

  interface PackageInstall {
    names: string[];
    manager?: PackageManager | undefined
}

  type ActionType = 
    | { type: "PackageInstall" } & PackageInstall
    | { type: "LinkDotfile" } & LinkDotfile
    | { type: "LinkDirectory" } & LinkDirectory
    | { type: "ExecuteCommand" } & ExecuteCommand
    | { type: "CopyFile" } & CopyFile
    | { type: "Directory" } & Directory
    | { type: "HttpDownload" } & HttpDownload
    | { type: "SystemdSocket" } & SystemdSocket
    | { type: "SystemdService" } & SystemdService;

  // Helper function signatures
  function defineModule(name: string): ModuleBuilder;
  function httpDownload(config: HttpDownload): ActionType;
  function directory(config: Directory): ActionType;
  function linkDirectory(config: LinkDirectory): ActionType;
  function linkDotfile(config: LinkDotfile): ActionType;
  function systemdService(config: SystemdService): ActionType;
  function executeCommand(config: ExecuteCommand): ActionType;
  function packageInstall(config: PackageInstallConfig): Box;
  function systemdSocket(config: SystemdSocket): ActionType;
  function packageInstall(config: PackageInstall): ActionType;

}

export {};
