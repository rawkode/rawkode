# mkApp - Creates platform-aware home, nixos, and darwin module exports from a single definition
#
# Usage:
#   mkApp {
#     name = "myapp";
#
#     linux = {
#       home = { pkgs, ... }: { ... };    # home-manager on Linux (optional)
#       system = { config, ... }: { ... }; # NixOS system config (optional)
#     };
#
#     darwin = {
#       home = { pkgs, ... }: { ... };    # home-manager on Darwin (optional)
#       system = { lib, ... }: { ... };   # nix-darwin system config (optional)
#     };
#
#     common = {
#       home = { pkgs, ... }: { ... };    # home-manager for all platforms (optional)
#     };
#   }
#
# Returns a flake-parts compatible attribute set with:
#   - flake.homeModules.${name}   (platform-aware, uses isDarwin)
#   - flake.nixosModules.${name}  (linux.system)
#   - flake.darwinModules.${name} (darwin.system)
#   - flake.appBundles.${name}    (bundle with home/nixos/darwin modules)
_:
let
  noopModule = _: { };

  # Build a platform-aware home module using isDarwin from extraSpecialArgs
  # This returns a proper home-manager module function
  mkHomeModule =
    {
      linux ? { },
      darwin ? { },
      common ? { },
    }:
    # This is the home-manager module function that receives all module args
    { config, lib, pkgs, isDarwin, ... }@moduleArgs:
    let
      # Helper to safely evaluate a config (handles null, function, or attrset)
      evalConfig =
        cfg:
        if cfg == null then
          { }
        else if lib.isFunction cfg then
          cfg moduleArgs
        else if lib.isAttrs cfg then
          cfg
        else
          throw "mkApp: config must be null, function, or attrset, got ${builtins.typeOf cfg}";

      commonConfig = evalConfig (common.home or null);
      platformConfig =
        if isDarwin then evalConfig (darwin.home or null) else evalConfig (linux.home or null);

      # Extract imports from configs (imports must be handled at module level, not in mkMerge)
      commonImports = commonConfig.imports or [ ];
      platformImports = platformConfig.imports or [ ];
      allImports = commonImports ++ platformImports;

      # Extract options from configs (options must be at module level, not in config)
      commonOptions = commonConfig.options or { };
      platformOptions = platformConfig.options or { };
      allOptions = lib.recursiveUpdate commonOptions platformOptions;

      # Remove imports and options from configs before merging (they'll be added at module level)
      commonConfigClean = builtins.removeAttrs commonConfig [
        "imports"
        "options"
      ];
      platformConfigClean = builtins.removeAttrs platformConfig [
        "imports"
        "options"
      ];

      # If the cleaned configs have a "config" key, use that; otherwise use the whole config
      # This handles both { config = ...; } and direct config patterns
      commonConfigValue = commonConfigClean.config or commonConfigClean;
      platformConfigValue = platformConfigClean.config or platformConfigClean;
    in
    {
      imports = allImports;
      options = allOptions;
      config = lib.mkMerge [
        commonConfigValue
        platformConfigValue
      ];
    };

in
{
  name,
  linux ? { }, # { home = ...; system = ...; }
  darwin ? { }, # { home = ...; system = ...; }
  common ? { }, # { home = ...; }
}:
let
  homeModule = mkHomeModule { inherit linux darwin common; };
  nixosModule = linux.system or noopModule;
  darwinModule = darwin.system or noopModule;
in
{
  # Module exports for direct imports
  flake.homeModules.${name} = homeModule;
  flake.nixosModules.${name} = nixosModule;
  flake.darwinModules.${name} = darwinModule;

  # App bundle for type-safe imports in mkUser
  flake.appBundles.${name} = {
    home = homeModule;
    nixos = nixosModule;
    darwin = darwinModule;
  };
}
