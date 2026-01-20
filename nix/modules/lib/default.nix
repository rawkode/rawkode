# Custom library functions - Dendritic pattern
{ inputs, lib, ... }:
let
  mkUser = import ../../lib/mkUser.nix { inherit inputs lib; };
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
