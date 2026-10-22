{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;

  kororaCache = {
    extra-substituters = [ "https://korora-tech.cachix.org" ];
    extra-trusted-public-keys = [
      "korora-tech.cachix.org-1:42bs8TVW3uvxvMnuJtkXP5lkHFK7++Sral9uRDautuA="
    ];
  };
in
mkApp {
  name = "rockhopper";

  linux.home =
    { lib, pkgs, ... }:
    {
      nix.settings = kororaCache;

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

  linux.system = _: {
    nix.settings = kororaCache;
  };
}
