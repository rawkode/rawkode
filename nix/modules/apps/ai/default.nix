{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "ai";

  linux.home =
    { inputs, pkgs, ... }:
    {
      home.packages = with inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}; [
        amp
        codex
        cursor-agent
        gemini-cli
      ];
    };

  common.home =
    _:
    let
      skillsDir = ./skills;
      skillNames = builtins.attrNames (
        lib.filterAttrs (_name: type: type == "directory") (builtins.readDir skillsDir)
      );
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
            source = "${skillsDir}/${name}";
            force = true;
          };
        }) agentSkillDirs
      ) skillNames;
    in
    {
      home.file = builtins.listToAttrs skillFiles // {
        "AGENTS.md" = {
          source = ./AGENTS.md;
          force = true;
        };
      };

      programs.fish.shellAliases = {
        codex = ''codex --search --config commit_attribution='"This commit was created with the assistance of a LLM."' '';
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [
          "amp"
          "gemini-cli"
        ];
        casks = [
          "chatgpt"
          "codex"
          "codex-app"
          "openusage"
        ];
      };
    };
}
