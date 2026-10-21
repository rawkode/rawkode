{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rclone";

  # Remotes are created interactively with `rclone config` so OAuth and iCloud
  # trust tokens stay in ~/.config/rclone/rclone.conf. Home Manager's
  # programs.rclone regenerates that file on login, which would discard them.
  linux.home =
    { pkgs, ... }:
    let
      # Exit non-zero until the remote exists and has finished authenticating.
      hasCredential = pkgs.writeShellScript "rclone-has-credential" ''
        ${lib.getExe pkgs.rclone} config show "$1" 2>/dev/null | ${pkgs.gnugrep}/bin/grep -q "^$2 = ."
      '';

      googleDrive = description: {
        inherit description;
        credential = "token";
        extraArgs = [ "--poll-interval 1m" ];
      };

      # Service name (rclone-<remote>) → mount settings.
      mounts = {
        gdrive-personal = googleDrive "Google Drive (personal)" // {
          mountPoint = "%h/Cloud/Google-Personal";
        };
        gdrive-academy = googleDrive "Google Drive (Rawkode Academy)" // {
          mountPoint = "%h/Cloud/Google-RawkodeAcademy";
        };
        icloud = {
          description = "iCloud Drive";
          mountPoint = "%h/Cloud/iCloud";
          credential = "trust_token";
          # iCloud has no change notifications; refresh listings more often.
          extraArgs = [ "--dir-cache-time 5m" ];
        };
      };

      mkMount = remote: mount: {
        Unit.Description = "Mount ${mount.description} at ${mount.mountPoint}";
        Service = {
          Type = "notify";
          # fusermount3 is a setuid wrapper on NixOS.
          Environment = [ "PATH=/run/wrappers/bin" ];
          ExecCondition = "${hasCredential} ${remote} ${mount.credential}";
          ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p ${mount.mountPoint}";
          ExecStart = lib.concatStringsSep " " (
            [
              "${lib.getExe pkgs.rclone} mount ${remote}: ${mount.mountPoint}"
              "--vfs-cache-mode full"
              "--vfs-cache-max-size 20G"
            ]
            ++ mount.extraArgs
          );
          ExecStop = "/run/wrappers/bin/fusermount3 -uz ${mount.mountPoint}";
          Restart = "on-failure";
          RestartSec = 30;
        };
        Install.WantedBy = [ "default.target" ];
      };
    in
    {
      home.packages = [ pkgs.rclone ];

      systemd.user.services = lib.mapAttrs' (
        remote: mount: lib.nameValuePair "rclone-${remote}" (mkMount remote mount)
      ) mounts;

      # Start each mount as soon as `rclone config` saves its credentials,
      # instead of waiting for the next login.
      systemd.user.paths = lib.mapAttrs' (
        remote: _:
        lib.nameValuePair "rclone-${remote}" {
          Unit.Description = "Start rclone-${remote} when its credentials are saved";
          Path = {
            PathChanged = "%h/.config/rclone/rclone.conf";
            Unit = "rclone-${remote}.service";
          };
          Install.WantedBy = [ "default.target" ];
        }
      ) mounts;
    };
}
