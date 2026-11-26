{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    { config, lib, ... }:
    {
      imports = [ inputs.flipper.homeModules.default ];

      programs.flipper = {
        enable = true;
        defaultBrowser = true;
        nativeMessaging.firefox = config.programs.firefox.enable;
        settings = {
          routing.mode = "picker";
          rules = lib.optionals config.programs.firefox.enable [
            {
              # gitsign's OIDC sign-in must use the rawkode.academy identity.
              name = "Sigstore sign-in";
              domains = [ "oauth2.sigstore.dev" ];
              action = "open";
              profile = "firefox-nightly:3pzugki6.default#container-1";
            }
          ];
        };
      };

      # google-chrome forces text/html; keep Flipper ahead of it.
      xdg.mimeApps.defaultApplications."text/html" = lib.mkForce [ "com.korora.Flipper.desktop" ];
    };
}
