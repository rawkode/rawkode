_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "handy";

  linux.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      home.packages = [
        pkgs.handy
        pkgs.wtype
      ];

      systemd.user.services.handy = {
        Unit = {
          Description = "Handy offline voice dictation";
          After = [ "graphical-session.target" ];
          PartOf = [ "graphical-session.target" ];
        };
        Service = {
          ExecStart = "${lib.getExe pkgs.handy} --start-hidden";
          # Handy discovers the Wayland typing helper at runtime.
          Environment = [
            "PATH=${lib.makeBinPath [ pkgs.wtype ]}:${config.home.profileDirectory}/bin:/run/current-system/sw/bin"
          ];
          Restart = "on-failure";
          RestartSec = 5;
        };
        Install.WantedBy = [ "graphical-session.target" ];
      };

      programs.niri.settings.binds."Super+D" = {
        hotkey-overlay.title = "Toggle voice dictation";
        action.spawn = [
          (lib.getExe pkgs.handy)
          "--toggle-transcription"
        ];
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "handy" ];
      };
    };
}
