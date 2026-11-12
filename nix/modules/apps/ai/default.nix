_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "ai";

  linux.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.apps.ai;
      agentPackages = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
      # Keep Python and its packages aligned with Hermes' own nixpkgs input.
      hermesPython =
        inputs.llm-agents.inputs.nixpkgs.legacyPackages.${pkgs.stdenv.hostPlatform.system}.python3;
      googleDependencies = with hermesPython.pkgs; [
        google-api-python-client
        google-auth-oauthlib
        google-auth-httplib2
      ];
      hermesAgent = agentPackages.hermes-agent.overridePythonAttrs (old: {
        dependencies = (old.dependencies or [ ]) ++ googleDependencies;
        # Hermes launches skills/workers through HERMES_PYTHON, not just its CLI.
        makeWrapperArgs = (old.makeWrapperArgs or [ ]) ++ [
          "--set"
          "HERMES_PYTHON"
          "${hermesPython.withPackages (_: (old.dependencies or [ ]) ++ googleDependencies)}/bin/python3"
        ];
        pythonImportsCheck = (old.pythonImportsCheck or [ ]) ++ [
          "googleapiclient.discovery"
          "google_auth_oauthlib.flow"
          "google_auth_httplib2"
        ];
      });
    in
    {
      config = lib.mkMerge [
        (lib.mkIf cfg.hermes.enable {
          home.packages = [
            hermesAgent
            agentPackages.hermes-desktop
          ];

          # Keep Hermes' gateway under systemd so Desktop can attach to the wrapped
          # Nix CLI. Its unmanaged bootstrap starts bare sys.executable, which lacks
          # the Python dependencies supplied by the hermes-agent wrapper.
          systemd.user.services.hermes-gateway = {
            Unit.Description = "Hermes Agent gateway";
            Service = {
              ExecStart = "${lib.getExe agentPackages.hermes-agent} gateway run --quiet";
              Restart = "on-failure";
              RestartSec = 5;
            };
            Install.WantedBy = [ "default.target" ];
          };
        })
        (lib.mkIf cfg.cliPackages.enable {
          home.packages = [
            # Computer-use MCP server (`cua-driver mcp`); ImageMagick provides
            # the `import` command it shells out to for window screenshots.
            inputs.cua.packages.${pkgs.stdenv.hostPlatform.system}.cua-driver
            pkgs.imagemagick
            agentPackages.amp
            agentPackages.antigravity-cli
            agentPackages.claude-code
            agentPackages.codex
            agentPackages.opencode2
            agentPackages.opencode2-desktop
          ];
        })
      ];
    };

  common.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.apps.ai;
      agentPackages = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
      skillsDir = ./skills;
      localSkills = lib.mapAttrs (name: _type: "${skillsDir}/${name}") (
        lib.filterAttrs (_name: type: type == "directory") (builtins.readDir skillsDir)
      );
      skills = localSkills;
      # Each agent discovers personal skills from its own directory.
      agentSkillDirs = [
        ".codex/skills"
        ".copilot/skills"
      ];
      skillFiles = lib.concatMap (
        name:
        map (dir: {
          name = "${dir}/${name}";
          value = {
            source = skills.${name};
            force = true;
          };
        }) agentSkillDirs
      ) (builtins.attrNames skills);
    in
    {
      options.rawkOS.apps.ai.cliPackages.enable = lib.mkEnableOption "AI CLI packages" // {
        default = true;
      };

      options.rawkOS.apps.ai.hermes.enable =
        lib.mkEnableOption "the Hermes agent, its desktop app, and its gateway service";

      config = {
        home.packages = lib.optionals cfg.cliPackages.enable [
          agentPackages.antigravity-hub
          agentPackages.ccusage
          agentPackages.paperclip
        ];

        home.file = builtins.listToAttrs skillFiles // {
          "AGENTS.md" = {
            source = ./AGENTS.md;
            force = true;
          };
          ".codex/AGENTS.md" = {
            source = ./AGENTS.md;
            force = true;
          };
        };

        programs.fish.shellAliases = lib.optionalAttrs cfg.cliPackages.enable {
          codex = ''codex --approve-for-me --search --config commit_attribution='"This commit was created with the assistance of a LLM."' '';
        };

        programs.nushell.shellAliases = lib.optionalAttrs cfg.cliPackages.enable {
          codex = "codex --approve-for-me";
        };
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        taps = [ "ampcode/tap" ];
        brews = [
          {
            name = "ampcode/tap/ampcode";
            conflicts_with = [ "amp" ];
          }
          "gemini-cli"
        ];
        casks = [
          "antigravity-cli"
          "chatgpt"
          "claude-code@latest"
          "codex"
          "openusage"
        ];
      };
    };
}
