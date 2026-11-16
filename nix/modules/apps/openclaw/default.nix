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
      # Secrets come from 1Password at service start and live only in the
      # runtime directory (tmpfs), never in the Nix store or on disk.
      secrets = {
        OPENCLAW_GATEWAY_TOKEN = "op://Private/openclaw/password";
      };
      runtimeEnvFile = "%t/openclaw/secrets.env";
      fetchSecrets = pkgs.writeShellApplication {
        name = "openclaw-fetch-secrets";
        text = ''
          # The setgid wrapper is required for 1Password desktop integration.
          op() { /run/wrappers/bin/op --account my.1password.eu "$@"; }
          dir="$XDG_RUNTIME_DIR/openclaw"
          umask 077
          mkdir -p "$dir"

          # The service starts with the graphical session, which can be before
          # 1Password is running and unlocked, so wait for it.
          for _ in $(seq 1 60); do
            if op read ${lib.escapeShellArg (builtins.head (builtins.attrValues secrets))} >/dev/null 2>&1; then
              break
            fi
            sleep 2
          done

          tmp=$(mktemp "$dir/secrets.env.XXXXXX")
          {
            ${lib.concatStringsSep "\n            " (
              lib.mapAttrsToList (
                name: ref: "printf '%s=%s\\n' ${name} \"$(op read ${lib.escapeShellArg ref})\""
              ) secrets
            )}
          } > "$tmp"
          mv "$tmp" "$dir/secrets.env"

          # The CLI loads the state directory's .env, so pointing it at the
          # runtime file lets local commands such as `openclaw devices approve`
          # authenticate. A regular file there is left alone.
          env=${lib.escapeShellArg "${cfg.stateDir}/.env"}
          if [ -L "$env" ] || [ ! -e "$env" ]; then
            ln -sfn "$dir/secrets.env" "$env"
          fi
        '';
      };
      # OpenClaw's own certificate generation only runs openssl from fixed
      # system directories, which NixOS leaves empty, so create the pair it
      # would generate at the paths it reads.
      tlsDir = "${cfg.stateDir}/gateway/tls";
      generateTls = pkgs.writeShellApplication {
        name = "openclaw-gateway-tls";
        runtimeInputs = [ pkgs.openssl ];
        text = ''
          if [ ! -s ${tlsDir}/gateway-cert.pem ] || [ ! -s ${tlsDir}/gateway-key.pem ]; then
            umask 077
            mkdir -p ${tlsDir}
            openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
              -keyout ${tlsDir}/gateway-key.pem -out ${tlsDir}/gateway-cert.pem \
              -subj /CN=openclaw-gateway 2>/dev/null
          fi
        '';
      };
      # nix-openclaw only materializes bootstrap files into the main workspace,
      # so link them into the other agents' workspaces here. They share the
      # main workspace's conventions, environment, and user model, and have
      # their own identity and soul.
      agentWorkspaces = {
        social = "${cfg.stateDir}/workspace-social";
        content = "${cfg.stateDir}/workspace-content";
      };
      agentWorkspaceFiles = lib.concatMapAttrs (
        agent: dir:
        let
          relative = lib.removePrefix "${config.home.homeDirectory}/" dir;
        in
        {
          "${relative}/AGENTS.md".source = ./workspace/AGENTS.md;
          "${relative}/TOOLS.md".source = ./workspace/TOOLS.md;
          "${relative}/USER.md".source = ./workspace/USER.md;
          "${relative}/IDENTITY.md".source = ./agents/${agent}/IDENTITY.md;
          "${relative}/SOUL.md".source = ./agents/${agent}/SOUL.md;
        }
      ) agentWorkspaces;
    in
    {
      imports = [ inputs.nix-openclaw.homeManagerModules.openclaw ];

      home.file = agentWorkspaceFiles;

      nixpkgs.overlays = [ inputs.nix-openclaw.overlays.default ];

      programs.openclaw = {
        enable = true;
        # Nix owns these files; nix-openclaw then skips OpenClaw's template
        # seeding. memory/ and DREAMS.md remain runtime-owned.
        workspace.bootstrapFiles = {
          agents = ./workspace/AGENTS.md;
          soul = ./workspace/SOUL.md;
          tools = ./workspace/TOOLS.md;
          identity = ./workspace/IDENTITY.md;
          user = ./workspace/USER.md;
        };
        # The config is a read-only store path, so the Control UI cannot save
        # these; change them here.
        config.agents.defaults = {
          model = {
            primary = "openai/gpt-6.1-sol";
            fallbacks = [ "openai/gpt-6.1-terra" ];
          };
          # Short internal tasks (titles, progress narration) and typed
          # choices/scores use the cheaper model.
          utilityModel = "openai/gpt-6-luna";
          decisionModel = "openai/gpt-6-luna";
          # Rocko, the personal assistant, owns ambient system work and
          # heartbeats; the multi-agent roster has no implicit owner.
          systemAgent.agentId = "rocko";
          heartbeat.agentId = "rocko";
          # thinkingDefault and fastModeDefault are left unset to use
          # OpenClaw's defaults.
        };
        # Rocko, the personal assistant, uses the main workspace above. The
        # other agents get their own workspaces; see agentWorkspaces.
        # Realtime voice (Talk) uses OpenAI's live model; Talk sessions without
        # an agent go to Rocko.
        config.talk = {
          agentId = "rocko";
          realtime = {
            provider = "openai";
            model = "gpt-live-1";
          };
        };
        # Multi-agent rosters need explicit ownership: each channel, cron job,
        # and heartbeat names the agent that owns it.
        config.agents.ownership = "explicit";
        config.agents.entries = {
          rocko = {
            name = "Rocko";
            # Without this, a multi-agent roster nests it under the default.
            workspace = "${cfg.stateDir}/workspace";
            identity = {
              name = "Rocko";
              emoji = "🪨";
            };
          };
          social = {
            name = "Social Media Manager";
            description = "Drafts and schedules posts, watches mentions, and reports engagement.";
            workspace = agentWorkspaces.social;
            identity = {
              name = "Social Media Manager";
              emoji = "📣";
            };
          };
          content = {
            name = "Content Lead";
            description = "Plans the content calendar and researches, drafts, and edits articles, scripts, and episodes.";
            workspace = agentWorkspaces.content;
            identity = {
              name = "Content Lead";
              emoji = "🎬";
            };
          };
        };
        # Enable the default model's provider here; OpenClaw cannot write its
        # usual auto-enable into the read-only config.
        # Both providers authenticate with subscription OAuth
        # (`openclaw models auth login`); credentials stay in the state dir.
        config.plugins.entries = {
          openai.enabled = true;
          anthropic.enabled = true;
        };
        config.gateway = {
          mode = "local";
          bind = "tailnet";
          inherit port;
          # Mobile setup codes need wss:// off-LAN. The self-signed certificate
          # is pinned by its fingerprint in the setup code; browsers warn once.
          tls.enabled = true;
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
          # Exec prepends POSIX syntax; leave the interactive login shell unchanged.
          Environment = [ "SHELL=${pkgs.runtimeShell}" ];
          # systemd reads EnvironmentFile= per command, so ExecStart sees a
          # token generated here on first start.
          ExecStartPre = [
            (lib.getExe fetchSecrets)
            (lib.getExe generateTls)
          ];
          # Optional because systemd also loads it before ExecStartPre has
          # written it; each command reloads it, so ExecStart sees the secrets.
          EnvironmentFile = [ "-${runtimeEnvFile}" ];
          # Allow time to wait for 1Password to unlock.
          TimeoutStartSec = "3min";
        };
        Install.WantedBy = [ "graphical-session.target" ];
      };

      # The gateway logs to /tmp/openclaw, which activation creates but a reboot
      # clears. systemd opens the log before ExecStartPre, so recreate it at login.
      systemd.user.tmpfiles.rules = [ "d /tmp/openclaw 0700 - - -" ];
    };
}
