_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "vivaldi";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = [ pkgs.vivaldi ];

      # Other browser modules also register handlers, so force the defaults.
      xdg.mimeApps = {
        enable = true;
        defaultApplications = lib.genAttrs [
          "text/html"
          "application/xhtml+xml"
          "x-scheme-handler/http"
          "x-scheme-handler/https"
        ] (_: lib.mkForce [ "vivaldi-stable.desktop" ]);
      };

      home.sessionVariables.BROWSER = "vivaldi";
    };

  linux.system = _: {
    # 1Password only trusts browsers it recognises by process name. The
    # launcher is `vivaldi`, but its executable is `vivaldi-bin`. `text` is a
    # lines option, so each browser module appends its own entries. The mode
    # makes this a root-owned file rather than a store symlink, which
    # 1Password refuses to read.
    environment.etc."1password/custom_allowed_browsers" = {
      text = ''
        vivaldi
        vivaldi-bin
      '';
      mode = "0755";
    };
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "vivaldi" ];
      };
    };
}
