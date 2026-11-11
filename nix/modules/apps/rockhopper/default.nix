{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rockhopper";

  linux.home =
    { lib, pkgs, ... }:
    let
      package = inputs.rockhopper.packages.${pkgs.stdenv.hostPlatform.system}.default;
    in
    {
      imports = [ inputs.rockhopper.homeManagerModules.default ];

      programs.rockhopper = {
        enable = true;
        # The flake's own build, not the overlay, so it is served from the cache.
        inherit package;
      };

      # Keep the daemon warm so the first open is instant.
      systemd.user.services.rockhopper = {
        Unit = {
          Description = "Rockhopper daemon";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session.target" ];
        };
        Service = {
          ExecStart = "${lib.getExe package} daemon";
          Restart = "on-failure";
        };
        Install.WantedBy = [ "graphical-session.target" ];
      };

      # Umbriel keybinds; this app is only bundled with the Umbriel desktop.
      programs.umbriel.settings.keybinds = {
        "Mod+Space" = {
          action = "spawn rockhopper";
          repeat = false;
        };
        "Mod+V" = {
          action = "spawn rockhopper clipboard";
          repeat = false;
        };
        "Mod+E" = {
          action = "spawn rockhopper emoji";
          repeat = false;
        };
      };
    };
}
