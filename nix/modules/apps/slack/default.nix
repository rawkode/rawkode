{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit (inputs.nixpkgs) lib; };
in
mkApp {
  name = "slack";

  home = {
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

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "slack" ];
      };
    };
}
