{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
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
    in
    {
      config = lib.mkIf cfg.cliPackages.enable {
        home.packages = with inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}; [
          amp
          codex
          cursor-agent
          gemini-cli
        ];
      };
    };

  common.home =
    {
      config,
      inputs,
      lib,
      ...
    }:
    let
      cfg = config.rawkOS.apps.ai;
      skillsDir = ./skills;
      localSkills = lib.mapAttrs (name: _type: "${skillsDir}/${name}") (
        lib.filterAttrs (_name: type: type == "directory") (builtins.readDir skillsDir)
      );
      externalSkills = {
        orchestration = "${inputs.orca}/skills/orchestration";
      };
      skills = localSkills // externalSkills;
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
        taps = [ "stablyai/orca" ];
        brews = [
          "amp"
          "gemini-cli"
          "orca"
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
