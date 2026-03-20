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

  # Build a platform-aware home module using isDarwin from extraSpecialArgs.
  # App home configs (common.home, linux.home, darwin.home) are standard modules —
  # we just import them conditionally and let the module system handle arg injection
  # and config merging.
  mkHomeModule =
    {
      linux ? { },
      darwin ? { },
      common ? { },
    }:
    { isDarwin, lib, ... }:
    {
      imports =
        lib.optional (common ? home) common.home
        ++ (
          if isDarwin then
            lib.optional (darwin ? home) darwin.home
          else
            lib.optional (linux ? home) linux.home
        );
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
