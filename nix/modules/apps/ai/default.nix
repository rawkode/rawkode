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
        pkgs.code-cursor-fhs

        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.codex
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.cursor-agent
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.qwen-code
      ];
    };

  common.home = {
    programs.fish.shellAbbrs = {
      codex = {
        position = "command";
        setCursor = true;
        expansion = "codex --search --full-auto";
      };
    };
  };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        brews = [
          "gemini-cli"
        ];
        casks = [
          "chatgpt"
          "claude-code"
          "codex"
          "cursor"
          "cursor-cli"
        ];
      };
    };
}
