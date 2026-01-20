{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "rquickshare";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        rquickshare
      ];

      home.file.".local/share/dev.mandre.rquickshare/.settings.json" = {
        enable = true;
        text = ''
          {
            "realclose": false,
            "autostart": true,
            "startminimized": true,
            "visibility": 0,
            "port": 39706
          }
        '';
        force = true;
      };
    };
}
