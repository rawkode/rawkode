{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rockhopper";

  linux.home =
    { lib, pkgs, ... }:
    {
      imports = [ inputs.rockhopper.homeManagerModules.default ];

      programs.rockhopper = {
        enable = true;
        # The flake's own build, not the overlay, so it is served from the cache.
        package = inputs.rockhopper.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };

      programs.niri.settings = {
        # Keep the daemon warm so the first open is instant.
        spawn-at-startup = [
          {
            command = [
              "rockhopper"
              "daemon"
            ];
          }
        ];

        binds = {
          # Replace DMS's launcher and clipboard bindings while retaining its other shortcuts.
          "Mod+Space".action = lib.mkForce { spawn = [ "rockhopper" ]; };
          "Mod+V".action = lib.mkForce {
            spawn = [
              "rockhopper"
              "clipboard"
            ];
          };
          "Super+E".action.spawn = [
            "rockhopper"
            "emoji"
          ];
        };
      };
    };

}
