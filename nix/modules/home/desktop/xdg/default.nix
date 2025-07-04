{ ... }:
{
  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "text/html" = [ "browsers.desktop" ];
      "x-scheme-handler/http" = [ "browsers.desktop" ];
      "x-scheme-handler/https" = [ "browsers.desktop" ];
    };
  };
}
