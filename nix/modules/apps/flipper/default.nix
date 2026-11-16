{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    { lib, ... }:
    let
      # Chrome Dev's Default profile is the rawkode.academy account.
      chromeAcademy = "chrome-dev:Default";
    in
    {
      imports = [ inputs.flipper.homeModules.default ];

      programs.flipper = {
        enable = true;
        defaultBrowser = true;
        nativeMessaging.firefox = true;
        settings = {
          # Chrome is the default browser: open unmatched links without a picker.
          routing = {
            mode = "always";
            defaultProfile = chromeAcademy;
          };
          rules = [
            {
              # gitsign's OIDC sign-in must use the rawkode.academy identity.
              name = "Sigstore sign-in";
              domains = [ "oauth2.sigstore.dev" ];
              action = "open";
              profile = chromeAcademy;
            }
          ];
        };
      };

      # google-chrome forces text/html; keep Flipper ahead of it.
      xdg.mimeApps.defaultApplications."text/html" = lib.mkForce [ "com.korora.Flipper.desktop" ];
    };
}
