{
  flake.homeModules.slack = {
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

  flake.darwinModules.slack =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "slack" ];
      };
    };
}
