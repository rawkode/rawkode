# Custom library functions - Dendritic pattern
{ inputs, ... }:
let
  inherit (inputs.nixpkgs) lib;
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
  mkApp = import ../../lib/mkApp.nix { inherit lib; };

  # Library functions (also exported via extraSpecialArgs in mkUser)
  rawkOSLib = {
    fileAsSeparatedString =
      path: lib.strings.concatStringsSep "\n" (lib.strings.splitString "\n" (builtins.readFile path));
  };
in
{
  flake.lib = {
    __functor = _self: _super: {
      rawkOS = {
        inherit (rawkOSLib) fileAsSeparatedString;
        inherit mkApp mkUser;
      };
    };
  };

  # Export mkApp for use in modules via: (import ../../lib/mkApp.nix { inherit lib; })
  # This allows modules to use mkApp without going through the functor
}
