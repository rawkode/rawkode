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
      config = lib.mkIf cfg.cliPackages.enable {
        home.packages = [
          agentPackages.claude-code
          agentPackages.codex
          hermesAgent
        ];
      };
    };

  common.home =
    {
      config,
      lib,
      ...
    }:
    let
      cfg = config.rawkOS.apps.ai;
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

      config = {
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
          codex = ''codex --search --config commit_attribution='"This commit was created with the assistance of a LLM."' '';
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
