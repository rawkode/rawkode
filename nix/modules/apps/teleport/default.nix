_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "teleport";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = [
        # Teleport vendors strcase, whose case-folding tables are generated for
        # Unicode 15 and panic at start-up under any other version. Go 1.27
        # ships Unicode 17, so build with Go 1.26.
        (pkgs.teleport_18.override { buildGoModule = pkgs.buildGo126Module; })
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
