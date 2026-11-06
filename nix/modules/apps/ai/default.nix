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
    in
    {
      config = lib.mkIf cfg.cliPackages.enable {
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
      };
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
