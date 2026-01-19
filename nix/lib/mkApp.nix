# mkApp - Creates home, nixos, and darwin module exports from a single definition
#
# Usage:
#   mkApp {
#     name = "myapp";
#     home = { pkgs, ... }: { ... };      # Optional home-manager module
#     nixos = { config, ... }: { ... };   # Optional NixOS module
#     darwin = { lib, ... }: { ... };     # Optional Darwin module
#   }
#
# Returns a flake-parts compatible attribute set with:
#   - flake.homeModules.${name}
#   - flake.nixosModules.${name}
#   - flake.darwinModules.${name}
{ lib }:
let
  noopModule = _: { };
in
{
  name,
  home ? null,
  nixos ? null,
  darwin ? null,
}:
{
  flake.homeModules = lib.optionalAttrs (home != null) { ${name} = home; };
  flake.nixosModules.${name} = if nixos == null then noopModule else nixos;
  flake.darwinModules.${name} = if darwin == null then noopModule else darwin;
}
