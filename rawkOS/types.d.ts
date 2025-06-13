// Generated TypeScript definitions for DHD
// This file provides global type definitions for dhd modules

declare global {
  // Type definitions
  /**
   * ///  Creates a symbolic link at a specified location pointing to a directory
   */
  ///  Creates a symbolic link at a specified location pointing to a directory
/// 
///  * `source` - Path where the symlink will be created
///    - If absolute: used as-is
///    - If starts with `~/`: expanded to home directory
///    - If relative: resolved relative to XDG_CONFIG_HOME (usually ~/.config)
///  * `target` - Path to the target directory that the symlink points to, relative to the module directory
///  * `force` - If true, creates parent directories and overwrites existing files/directories
  interface LinkDirectory {
    source: string;
    target: string;
    force: boolean
}

  interface Directory {
    path: string;
    escalate?: boolean | undefined
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

  /**
   * ///  System information available to conditions
   */
  ///  System information available to conditions
  interface SystemInfo {
    os: OsInfo;
    hardware: HardwareInfo;
    auth: AuthInfo;
    user: UserInfo
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

  /**
   * ///  Creates a symbolic link at a specified location
   */
  ///  Creates a symbolic link at a specified location
/// 
///  * `source` - Path where the symlink will be created
///    - If absolute: used as-is
///    - If starts with `~/`: expanded to home directory
///    - If relative: resolved relative to XDG_CONFIG_HOME (usually ~/.config)
///  * `target` - Path to the target file that the symlink points to, relative to the module directory
///  * `force` - If true, creates parent directories and overwrites existing files
  interface LinkFile {
    source: string;
    target: string;
    force: boolean
}

  /**
   * ///  Git configuration that accepts a nested object structure
   */
  ///  Git configuration that accepts a nested object structure
  interface GitConfig {
    /**
     *  Global git configuration (~/.gitconfig)
     */
    global?: Value | undefined;
    /**
     *  System git configuration (/etc/gitconfig)
     */
    system?: Value | undefined;
    /**
     *  Local git configuration (repository-specific)
     */
    local?: Value | undefined
}

  interface GitConfigEntry {
    /**
     *  The configuration key (e.g., "user.name", "core.editor", "alias.co")
     */
    key: string;
    /**
     *  The value for this key
     */
    value: string;
    /**
     *  Whether to add this value (for multi-valued keys) instead of replacing
     */
    add?: boolean | undefined
}

  interface CopyFile {
    source: string;
    target: string;
    escalate: boolean
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

  interface SystemdSocket {
    name: string;
    description: string;
    listenStream: string;
    scope: string
}

  interface PackageInstall {
    names: string[];
    manager?: PackageManager | undefined
}

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

  interface SystemdService {
    name: string;
    description: string;
    execStart: string;
    serviceType: string;
    scope: string;
    restart?: string | undefined;
    restartSec?: number | undefined
}

  /**
   * ///  Remove packages from the system
   */
  ///  Remove packages from the system
  interface PackageRemove {
    /**
     *  List of package names to remove
     */
    names: string[];
    /**
     *  Optional package manager to use
     */
    manager?: PackageManager | undefined
}

  interface PackageInstallConfig {
    names: PlatformSelect;
    manager?: PackageManagerType | undefined;
    module?: string | undefined
}

  /**
   * ///  Install GNOME Shell extensions
   */
  ///  Install GNOME Shell extensions
  interface InstallGnomeExtensions {
    /**
     *  List of extension IDs to install
     */
    extensions: string[]
}

  /**
   * ///  A conditional wrapper action that executes a child action based on conditions
   */
  ///  A conditional wrapper action that executes a child action based on conditions
  interface ConditionalAction {
    /**
     *  The wrapped action to conditionally execute
     */
    action: Box;
    /**
     *  Conditions to evaluate - if using multiple, they're AND'ed together
     */
    conditions: Condition[];
    /**
     *  If true, skip when conditions pass (skipIf), if false run only when conditions pass (onlyIf)
     */
    skipOnSuccess: boolean
}

  interface SystemdManage {
    name: string;
    operation: string;
    scope: string
}

  /**
   * ///  Configuration for executing a command.
   */
  ///  Configuration for executing a command.
/// 
///  This structure defines the parameters for executing a shell command.
///  It supports specifying the shell, command, arguments, and whether to escalate privileges.
  interface ExecuteCommand {
    /**
     *  If not specified, defaults to "sh".
     */
    shell?: string | undefined;
    /**
     *  This is the main command string that will be executed.
     */
    command: string;
    /**
     *  These are additional arguments passed to the command.
     */
    args?: string[] | undefined;
    /**
     *  If not specified, defaults to false.
     */
    escalate?: boolean | undefined
}

  /**
   * ///  Import dconf settings from a file
   */
  ///  Import dconf settings from a file
  interface DconfImport {
    /**
     *  Path to the dconf file to import
     */
    source: string;
    /**
     *  The dconf path to import to (e.g., "/org/gnome/desktop/")
     */
    path: string
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
  function linkDirectory(config: LinkDirectory): ActionType;
  function directory(config: Directory): ActionType;
  function httpDownload(config: HttpDownload): ActionType;
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
  function gitConfig(config: GitConfig): ActionType;
  function copyFile(config: CopyFile): ActionType;
  function systemdSocket(config: SystemdSocket): ActionType;
  function packageInstall(config: PackageInstall): ActionType;
  function defineModule(name: string): ModuleBuilder;
  function systemdService(config: SystemdService): ActionType;
  function packageRemove(config: PackageRemove): ActionType;
  function packageInstall(config: PackageInstallConfig): Box;
  function installGnomeExtensions(config: InstallGnomeExtensions): ActionType;
  function onlyIf(action: ActionType, conditions: Condition[]): ActionType;
  function skipIf(action: ActionType, conditions: Condition[]): ActionType;
  function systemdManage(config: SystemdManage): ActionType;
  function executeCommand(config: ExecuteCommand): ActionType;
  function dconfImport(config: DconfImport): ActionType;

}

export {};
