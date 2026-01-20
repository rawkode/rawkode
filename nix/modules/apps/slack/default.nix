{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "slack";

  linux.home = {
    services.flatpak.packages = [
      "com.slack.Slack"
    ];

    xdg = {
      enable = true;
      mime.enable = true;
      mimeApps = {
        enable = true;
        associations.added = {
          "x-scheme-handler/slack" = [ "com.slack.Slack.desktop" ];
        };
      };
    };
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "slack" ];
      };
    };
}
