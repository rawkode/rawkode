{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "git-gitsign";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cacheSocket =
        if pkgs.stdenv.isDarwin then
          "${config.home.homeDirectory}/Library/Caches/sigstore/gitsign/cache.sock"
        else
          "${config.xdg.cacheHome}/sigstore/gitsign/cache.sock";
    in
    lib.mkMerge [
      {
        home.packages = [ pkgs.gitsign ];

        home.sessionVariables.GITSIGN_CREDENTIAL_CACHE = cacheSocket;

        programs.git = {
          signing = {
            format = "x509";
            signByDefault = true;
            signer = lib.getExe pkgs.gitsign;
          };

          settings = {
            commit.gpgsign = true;
            tag.gpgSign = true;
          };
        };
      }

      (lib.mkIf pkgs.stdenv.isLinux {
        home.file.".cache/sigstore/gitsign/.keep".text = "";

        systemd.user.services.gitsign-credential-cache = {
          Unit.Description = "GitSign credential cache";
          Service = {
            Type = "simple";
            ExecStart = "${pkgs.gitsign}/bin/gitsign-credential-cache --systemd-socket-activation";
          };
        };

        systemd.user.sockets.gitsign-credential-cache = {
          Unit.Description = "GitSign credential cache socket";
          Install.WantedBy = [ "sockets.target" ];
          Socket = {
            ListenStream = cacheSocket;
            DirectoryMode = "0700";
          };
        };
      })

      (lib.mkIf pkgs.stdenv.isDarwin {
        home.file."Library/Caches/sigstore/gitsign/.keep".text = "";

        launchd.agents.gitsign-credential-cache = {
          enable = true;
          config = {
            ProgramArguments = [ "${pkgs.gitsign}/bin/gitsign-credential-cache" ];
            EnvironmentVariables.GITSIGN_CREDENTIAL_CACHE = cacheSocket;
            KeepAlive = true;
            ProcessType = "Background";
            RunAtLoad = true;
            StandardOutPath = "${config.home.homeDirectory}/Library/Logs/gitsign-credential-cache.stdout.log";
            StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/gitsign-credential-cache.stderr.log";
          };
        };
      })
    ];
}
