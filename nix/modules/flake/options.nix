{ lib, ... }:
{
  options.flake.darwinModules = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Darwin modules exported by this flake.";
  };

  options.flake.darwinConfigurations = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.raw;
    default = { };
    description = "Darwin configurations exported by this flake.";
  };

  # NOTE: Other flake.* options (homeModules, nixosModules, nixosConfigurations,
  # overlays, packages, etc.) are provided elsewhere (via import-tree/flake-parts)
  # and should not be redeclared here to avoid merge conflicts.
}
