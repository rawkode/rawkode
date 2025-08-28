{ ... }:
{
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
}
