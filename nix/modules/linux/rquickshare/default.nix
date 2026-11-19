_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rquickshare";

  linux.system = _: {
    networking.firewall = {
      allowedTCPPorts = [ 39706 ];
      allowedUDPPorts = [ 39706 ];
    };
  };

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
