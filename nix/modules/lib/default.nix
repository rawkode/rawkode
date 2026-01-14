# Custom library functions - Dendritic pattern
{ inputs, ... }:
let
  inherit (inputs.nixpkgs) lib;
  noopModule = _: { };
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
in
{
  flake.lib = {
    __functor = _self: _super: {
      rawkOS = {
        fileAsSeparatedString =
          path: lib.strings.concatStringsSep "\n" (lib.strings.splitString "\n" (builtins.readFile path));

        mkApp =
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
          };

        inherit mkUser;
      };
    };
  };
}
