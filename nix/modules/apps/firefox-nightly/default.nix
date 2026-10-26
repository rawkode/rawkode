{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "firefox-nightly";

  # Stylix's Firefox target is absent when Stylix is disabled, so gate it on
  # `stylixHome` rather than referencing `stylix.*` unconditionally.
  common.home =
    {
      lib,
      stylixHome ? false,
      ...
    }:
    lib.optionalAttrs stylixHome {
      stylix.targets.firefox.profileNames = [ "default" ];
    };

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
            # Nix owns the profile; Mozilla accounts and Sync are not used.
            "identity.fxaccounts.enabled" = false;
          };

          extensions.packages =
            (with pkgs.nur.repos.rycee.firefox-addons; [
              catppuccin-web-file-icons
              firefox-translations
              onepassword-password-manager
              ublock-origin
            ])
            ++ [ flipperAddon ];

          # Keep Firefox's built-in container IDs: Flipper rules address
          # containers by ID.
          containersForce = true;
          containers = {
            Personal = {
              id = 1;
              color = "blue";
              icon = "fingerprint";
            };
            Work = {
              id = 2;
              color = "orange";
              icon = "briefcase";
            };
            Banking = {
              id = 3;
              color = "green";
              icon = "dollar";
            };
            Shopping = {
              id = 4;
              color = "pink";
              icon = "cart";
            };
          };
        };
      };

      # Firefox Nightly keeps its existing profile under the XDG config path; let
      # Home Manager manage that exact profile mapping in place.
      home.file.".config/mozilla/firefox/profiles.ini".force = true;

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
