{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    { lib, ... }:
    {
      imports = [ inputs.flipper.homeModules.default ];

      programs.flipper = {
        enable = true;
        defaultBrowser = true;
        nativeMessaging.firefox = true;
        settings.rules = [
          {
            name = "Sigstore sign-in";
            domains = [ "oauth2.sigstore.dev" ];
            action = "open";
            # Email selectors survive Chrome renumbering its profile directories.
            profile = "email:david@rawkode.academy";
          }
        ];
      };

      # google-chrome forces text/html; keep Flipper ahead of it.
      xdg.mimeApps.defaultApplications."text/html" = lib.mkForce [ "com.korora.Flipper.desktop" ];
    };
}
