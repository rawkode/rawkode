{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "openbot";

  common.home =
    {
      lib,
      pkgs,
      ...
    }:
    let
      package = inputs.openbot.packages.${pkgs.stdenv.hostPlatform.system}.default;
      linuxPackage =
        if pkgs.stdenv.hostPlatform.isLinux then
          package.overrideAttrs (old: {
            # The AppImage has `Exec=AppRun %U`, but upstream expects `--no-sandbox` here.
            # Keep upstream's strict replacement while matching the released desktop entry.
            buildCommand =
              lib.replaceStrings
                [ "--replace-fail 'Exec=AppRun --no-sandbox %U'" ]
                [ "--replace-fail 'Exec=AppRun %U'" ]
                old.buildCommand;
          })
        else
          package;
    in
    {
      home.packages = [ linuxPackage ];
    };
}
