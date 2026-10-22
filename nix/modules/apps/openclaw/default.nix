{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "openclaw";

  # Use nix-openclaw's matching module and package as a user service inside
  # the graphical session. It listens on loopback and the NetBird address
  # (OpenClaw's "tailnet" bind matches any 100.64.0.0/10 address). Remote
  # access goes through a NetBird reverse proxy service with SSO, which
  # signs the user in and passes their email on in X-NetBird-User.
  linux.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.programs.openclaw;
      port = 18789;
      # The NetBird reverse proxy service authenticates users. Its cluster's
      # peers (proxy-*.rka.internal) come and go, so trust the NetBird range;
      # NetBird policy must keep other peers off the gateway port.
      proxyOrigin = "https://rocko.eu1.netbird.services";
      netbirdRange = "100.64.0.0/16";
      # Same-host clients bypass the proxy, so they authenticate with a password.
      passwordFile = "${cfg.stateDir}/gateway-password.env";
      generatePassword = pkgs.writeShellApplication {
        name = "openclaw-gateway-password";
        runtimeInputs = [ pkgs.openssl ];
        text = ''
          if [ ! -s ${passwordFile} ]; then
            umask 077
            echo "OPENCLAW_GATEWAY_PASSWORD=$(openssl rand -hex 32)" > ${passwordFile}
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
          trustedProxies = [ netbirdRange ];
          # Setting origins replaces the loopback defaults, so keep them.
          controlUi.allowedOrigins = [
            "http://localhost:${toString port}"
            "http://127.0.0.1:${toString port}"
            proxyOrigin
          ];
          auth = {
            mode = "trusted-proxy";
            trustedProxy = {
              # The proxy's SSO mode sets the user's email here; unlike
              # NetBird-Only mode, it sends no X-NetBird-Groups.
              userHeader = "x-netbird-user";
              allowUsers = [ "david@rawkode.academy" ];
              # Proxy-authenticated browsers pair without approval on the host,
              # capped at OpenClaw's default non-admin operator scopes.
              deviceAutoApprove.enabled = true;
            };
            password = "\${OPENCLAW_GATEWAY_PASSWORD}";
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
          # password generated here on first start. Trusted-proxy mode refuses
          # to start if a gateway token is also set.
          ExecStartPre = lib.getExe generatePassword;
          EnvironmentFile = [
            "-${passwordFile}"
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
