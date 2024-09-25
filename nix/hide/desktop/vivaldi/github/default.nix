{ pkgs, ... }:
{
  xdg.desktopEntries = {
    github = {
      name = "GitHub";
      type = "Application";
      icon = ./icon.svg;
      noDisplay = false;
      terminal = false;
      startupNotify = true;
      exec = ''${pkgs.vivaldi}/bin/vivaldi --app="https://github.com" %U'';
      settings = {
        Keywords = "gmail";
        StartupWMClass = "vivaldi-github.com__-Default";
      };
      mimeType = [
        "text/html"
        "text/xml"
        "application/xhtml+xml"
        "application/xml"
        "application/rss+xml"
        "text/mml"
        "application/rdf+xml"
        "image/gif"
        "image/jpeg"
        "image/png"
        "x-scheme-handler/http"
        "x-scheme-handler/https"
        "x-scheme-handler/ftp"
        "x-scheme-handler/chrome"
        "video/webm"
        "application/x-xpinstall"
      ];
      actions = {
        link-handler = {
          exec = ''${pkgs.vivaldi}/bin/vivaldi --app=%U'';
          icon = ./icon.svg;
          name = "Link Handler";
        };
      };
    };
  };
}
