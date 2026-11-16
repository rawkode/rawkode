{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "teleport";

  linux.home =
    { pkgs, ... }:
    let
      pinned = inputs.nixpkgs-teleport.legacyPackages.${pkgs.stdenv.hostPlatform.system};
    in
    {
      home.packages = [
        # Teleport vendors strcase, whose case-folding tables are generated for
        # Unicode 15 and panic at start-up under any other version. Go 1.27
        # ships Unicode 17, so build with Go 1.26.
        (pinned.teleport_18.override { buildGoModule = pinned.buildGo126Module; })
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [ "teleport" ];
      };
    };
}
