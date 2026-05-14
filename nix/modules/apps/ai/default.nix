{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "ai";

  linux.home =
    { inputs, pkgs, ... }:
    {
      home.packages = [
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.amp
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.claude-code
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.codex
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.cursor-agent
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
      ];
    };

  common.home =
    { inputs, ... }:
    let
      skillsDir = inputs.impeccable + "/.agents/skills";
      skillNames = builtins.attrNames (
        lib.filterAttrs (_name: type: type == "directory") (builtins.readDir skillsDir)
      );
    in
    {
      home.file =
        builtins.listToAttrs (
          map (name: {
            name = ".agents/skills/${name}";
            value = {
              source = "${skillsDir}/${name}";
              force = true;
            };
          }) skillNames
        )
        // {
          "AGENTS.md" = {
            source = ./AGENTS.md;
            force = true;
          };
        };

      xdg.configFile."claude/settings.json".text = builtins.toJSON {
        attribution = {
          commit = "This commit was created with the assistance of a LLM.";
          pr = "This PR was created with the assistance of a LLM.";
        };
      };

      programs.fish.shellAliases = {
        claude = "claude --settings ~/.config/claude/settings.json --chrome";
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
          "claude"
          "claude-code@latest"
          "codex"
          "codex-app"
          "openusage"
        ];
      };
    };
}
