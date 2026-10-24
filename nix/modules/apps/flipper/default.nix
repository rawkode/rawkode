{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "flipper";

  linux.home =
    {
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = [ inputs.flipper.packages.${pkgs.stdenv.hostPlatform.system}.default ];

      xdg.mimeApps = {
        enable = true;
        defaultApplications = lib.genAttrs [
          "text/html"
          "x-scheme-handler/http"
          "x-scheme-handler/https"
        ] (_: lib.mkForce [ "com.korora.Flipper.desktop" ]);
      };
    };
}
