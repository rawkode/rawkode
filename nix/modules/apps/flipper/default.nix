{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    { config, lib, ... }:
    let
      firefox = config.programs.firefox;
      # Flipper's Firefox profile ID, derived from the Firefox module so a new
      # profile path, container ID or Firefox edition cannot strand the rule.
      # Flipper names the browser after its command, which is mainProgram.
      firefoxContainer =
        profileName: containerName:
        let
          profile = firefox.profiles.${profileName};
        in
        "${firefox.package.meta.mainProgram}:${profile.path}#container-${toString profile.containers.${containerName}.id}";
    in
    {
      imports = [ inputs.flipper.homeModules.default ];

      programs.flipper = {
        enable = true;
        defaultBrowser = true;
        nativeMessaging.firefox = true;
        settings.rules = lib.optionals firefox.enable [
          {
            name = "Sigstore sign-in";
            domains = [ "oauth2.sigstore.dev" ];
            action = "open";
            profile = firefoxContainer "default" "RawkodeAcademy";
          }
        ];
      };

      # google-chrome forces text/html; keep Flipper ahead of it.
      xdg.mimeApps.defaultApplications."text/html" = lib.mkForce [ "com.korora.Flipper.desktop" ];
    };
}
