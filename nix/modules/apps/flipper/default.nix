{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
(mkApp {
  name = "flipper";

  linux.home =
    {
      lib,
      pkgs,
      ...
    }:
    let
      flipper = inputs.flipper.packages.${pkgs.stdenv.hostPlatform.system}.default;
      nativeHost = pkgs.writeShellApplication {
        name = "flipper-native-host";
        runtimeInputs = [ flipper ];
        text = ''
          exec flipper --native-host "$@"
        '';
      };
    in
    {
      home.packages = [ flipper ];

      home.file.".mozilla/native-messaging-hosts/com.korora.flipper.json".text = builtins.toJSON {
        name = "com.korora.flipper";
        description = "Flipper browser picker";
        path = "${nativeHost}/bin/flipper-native-host";
        type = "stdio";
        allowed_extensions = [ "flipper@korora.tech" ];
      };

      xdg.mimeApps = {
        enable = true;
        defaultApplications = lib.genAttrs [
          "text/html"
          "x-scheme-handler/http"
          "x-scheme-handler/https"
        ] (_: lib.mkForce [ "com.korora.Flipper.desktop" ]);
      };
    };
})
// {
  perSystem =
    { lib, pkgs, ... }:
    {
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        flipper-firefox-addon =
          let
            flipper = inputs.flipper.packages.${pkgs.stdenv.hostPlatform.system}.default;
            addonId = "flipper@korora.tech";
            firefoxExtensionsGuid = "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";
          in
          pkgs.runCommand "flipper-firefox-addon-0.2.0"
            {
              nativeBuildInputs = [ pkgs.zip ];
              passthru.addonId = addonId;
            }
            ''
              install -d "$out/share/mozilla/extensions/${firefoxExtensionsGuid}"
              cd "${flipper}/share/flipper/extensions/firefox"
              zip -q -r "$out/share/mozilla/extensions/${firefoxExtensionsGuid}/${addonId}.xpi" .
            '';
      };
    };
}
