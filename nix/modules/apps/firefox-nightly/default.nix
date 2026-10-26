{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "firefox-nightly";

  linux.home =
    { pkgs, ... }:
    let
      firefoxNightly =
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin;
      flipperAddon = inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.flipper-firefox-addon;
    in
    {
      programs.firefox = {
        enable = true;
        package = firefoxNightly;
        configPath = ".config/mozilla/firefox";
        profiles.default = {
          id = 0;
          path = "agm4ycei.default";
          isDefault = true;
          settings = {
            "xpinstall.signatures.required" = false;
            # Enable add-ons placed in the profile directory (scope 1) without a prompt.
            "extensions.autoDisableScopes" = 14;
            "privacy.userContext.enabled" = true;
            "privacy.userContext.ui.enabled" = true;
          };
        };
      };

      # Firefox Nightly keeps its existing profile under the XDG config path; let
      # Home Manager manage that exact profile mapping in place.
      home.file.".config/mozilla/firefox/profiles.ini".force = true;

      # Add this XPI without replacing the existing profile extensions directory.
      home.file.".config/mozilla/firefox/agm4ycei.default/extensions/flipper@korora.tech.xpi".source =
        "${flipperAddon}/share/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}/flipper@korora.tech.xpi";

      xdg.mimeApps = {
        enable = true;
        defaultApplications."x-scheme-handler/about" = [ "firefox-nightly.desktop" ];
      };
    };

  linux.system =
    { inputs, pkgs, ... }:
    {
      environment.systemPackages = [
        inputs.firefox-nightly.packages.${pkgs.stdenv.hostPlatform.system}.firefox-nightly-bin
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "firefox@nightly" ];
      };
    };
}
