{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "docker";

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        docker-client
        docker-compose
      ];

      xdg.configFile."docker/config.json".text = ''
        {
          "auths": {},
          "credsStore": "secretservice"
        }
      '';
    };
}
