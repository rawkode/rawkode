// Generated TypeScript definitions for DHD
// This file provides global type definitions for dhd modules

declare global {
  // Type definitions
  interface SystemdService {
    name: string;
    description: string;
    execStart: string;
    serviceType: string;
    scope: string;
    restart?: string | undefined;
    restartSec?: number | undefined
}

  interface PackageInstallConfig {
    names: PlatformSelect;
    manager?: PackageManagerType | undefined;
    module?: string | undefined
}

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

  interface Directory {
    path: string;
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
    | "GitHub"
    | "Npm"
    | "Pacman"
    | "Snap"
    | "Go"
    | "Yum"
    | "Zypper"
    | "Pip"
    | "Gem"
    | "Nix"
    | "Uv";

  interface SystemdSocket {
    name: string;
    description: string;
    listenStream: string;
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
    escalate?: boolean | undefined;
    /**
     *  - "literal://value" for literal values
     */
    environment?: HashMap | undefined
}

  interface SystemdManage {
    name: string;
    operation: string;
    scope: string
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

  interface PropertyBuilder {


      equals(value: string): Condition;
      notEquals(value: string): Condition;
      contains(value: string): Condition;
      startsWith(value: string): Condition;
      endsWith(value: string): Condition
  }

  interface ConditionBuilder {


      and(other: Condition): this;
      or(other: Condition): this;
      not(): this;
      build(): Condition
  }

  type Condition = 
    | { type: "AllOf" }
    | { type: "AnyOf" }
    | { type: "Not" }
    | { type: "FileExists" }
    | { type: "DirectoryExists" }
    | { type: "CommandExists" }
    | { type: "CommandSucceeds" }
    | { type: "EnvironmentVariable" }
    | { type: "SystemProperty" }
    | { type: "SecretExists" };

  type ComparisonOperator = 
    | "Equals"
    | "NotEquals"
    | "Contains"
    | "StartsWith"
    | "EndsWith";

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

  // Utility type for extracting property paths from nested objects
  type Paths<T, P extends string = ""> = T extends object ? {
    [K in keyof T]: K extends string ?
      T[K] extends object ? Paths<T[K], `${P}${P extends "" ? "" : "."}${K}`> : `${P}${P extends "" ? "" : "."}${K}`
      : never
  }[keyof T] : never;

  // All valid property paths for SystemInfo
  type SystemInfoPaths = Paths<SystemInfo>;

  // Helper function signatures
  function systemdService(config: SystemdService): ActionType;
  function packageInstall(config: PackageInstallConfig): Box;
  function linkFile(config: LinkFile): ActionType;
  function linkDirectory(config: LinkDirectory): ActionType;
  function httpDownload(config: HttpDownload): ActionType;
  function gitConfig(config: GitConfig): ActionType;
  function directory(config: Directory): ActionType;
  function dconfImport(config: DconfImport): ActionType;
  function copyFile(config: CopyFile): ActionType;
  function systemdSocket(config: SystemdSocket): ActionType;
  function executeCommand(config: ExecuteCommand): ActionType;
  function systemdManage(config: SystemdManage): ActionType;
  function packageInstall(config: PackageInstall): ActionType;
  function defineModule(name: string): ModuleBuilder;
  function secretExists(reference: string): Condition;
  function command(command: string): Condition;
  function or(a: Condition, b: Condition): Condition;
  function and(a: Condition, b: Condition): Condition;
  function property(path: SystemInfoPaths): PropertyBuilder;
  function property(path: string): PropertyBuilder;
  function envVar(name: string, value: string | undefined): Condition;
  function commandSucceeds(command: string, args: string[] | undefined): Condition;
  function commandExists(command: string): Condition;
  function directoryExists(path: string): Condition;
  function fileExists(path: string): Condition;
  function not(condition: Condition): Condition;
  function anyOf(conditions: Condition[]): Condition;
  function allOf(conditions: Condition[]): Condition;
  function packageRemove(config: PackageRemove): ActionType;
  function installGnomeExtensions(config: InstallGnomeExtensions): ActionType;
  function onlyIf(action: ActionType, conditions: Condition[]): ActionType;
  function skipIf(action: ActionType, conditions: Condition[]): ActionType;

}

export {};
