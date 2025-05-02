{
  xdg.mimeApps = {
    enable = true;

    defaultApplications = {
      "application/pdf" = "vivaldi-stable.desktop";

      "text/html" = "vivaldi-stable.desktop";
      "text/markdown" = "vscode.desktop";
      "text/plain" = "vscode.desktop";

      "x-scheme-handler/http" = "vivaldi-stable.desktop";
      "x-scheme-handler/https" = "vivaldi-stable.desktop";
      "x-scheme-handler/mailto" = "vivaldi-stable.desktop";
      "x-scheme-handler/tana" = "tana.desktop";
      "x-scheme-handler/terminal" = "org.wezfurlong.wezterm.desktop";
    };
  };
}
