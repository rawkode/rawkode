{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "openclaw";

  # Use nix-openclaw's matching module and package as a user service inside
  # the graphical session. It listens on loopback and the NetBird address
  # (OpenClaw's "tailnet" bind matches any 100.64.0.0/10 address).
  linux.home =
    {
      config,
      lib,
      machine ? null,
      pkgs,
      ...
    }:
    let
      cfg = config.programs.openclaw;
      port = 18789;
      # NetBird's short and fully qualified DNS names for this peer. The
      # machine name is the hostname, and unlike osConfig it is also set for
      # standalone Home Manager, which must not drop these origins.
      netbirdOrigins = lib.optionals (machine != null) [
        "https://${machine}:${toString port}"
        "https://${machine}.rka.internal:${toString port}"
      ];
      # The CLI loads the state directory's .env, so keeping the token there
      # lets local commands such as `openclaw devices approve` authenticate.
      tokenFile = "${cfg.stateDir}/.env";
      legacyTokenFile = "${cfg.stateDir}/gateway-token.env";
      generateToken = pkgs.writeShellApplication {
        name = "openclaw-gateway-token";
        runtimeInputs = with pkgs; [
          gnugrep
          openssl
        ];
        text = ''
          if ! grep -qs '^OPENCLAW_GATEWAY_TOKEN=' ${tokenFile}; then
            umask 077
            # Keep the token devices already use from the old location.
            if grep -qs '^OPENCLAW_GATEWAY_TOKEN=' ${legacyTokenFile}; then
              grep '^OPENCLAW_GATEWAY_TOKEN=' ${legacyTokenFile} >> ${tokenFile}
            else
              echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)" >> ${tokenFile}
            fi
            chmod 600 ${tokenFile}
          fi
        '';
      };
    in
    {
      imports = [ inputs.nix-openclaw.homeManagerModules.openclaw ];

      nixpkgs.overlays = [ inputs.nix-openclaw.overlays.default ];

      programs.openclaw = {
        enable = true;
        config.gateway = {
          mode = "local";
          bind = "tailnet";
          inherit port;
          # Mobile setup codes need wss:// off-LAN. The self-signed certificate
          # is pinned by its fingerprint in the setup code; browsers warn once.
          tls = {
            enabled = true;
            autoGenerate = true;
          };
          # Setting origins replaces the loopback defaults, so keep them.
          controlUi.allowedOrigins = [
            "https://localhost:${toString port}"
            "https://127.0.0.1:${toString port}"
          ]
          ++ netbirdOrigins;
          auth = {
            mode = "token";
            token = "\${OPENCLAW_GATEWAY_TOKEN}";
          };
        };
      };

      systemd.user.services.${cfg.systemd.unitName} = {
        Unit = {
          After = [ "graphical-session.target" ];
          PartOf = [ "graphical-session.target" ];
        };
        Service = {
          # systemd reads EnvironmentFile= per command, so ExecStart sees a
          # token generated here on first start.
          ExecStartPre = lib.getExe generateToken;
          EnvironmentFile = [
            "-${tokenFile}"
            # Provider API keys and channel tokens, e.g. ANTHROPIC_API_KEY.
            "-${cfg.stateDir}/secrets.env"
          ];
        };
        Install.WantedBy = [ "graphical-session.target" ];
      };

      # The gateway logs to /tmp/openclaw, which activation creates but a reboot
      # clears. systemd opens the log before ExecStartPre, so recreate it at login.
      systemd.user.tmpfiles.rules = [ "d /tmp/openclaw 0700 - - -" ];
    };
}
