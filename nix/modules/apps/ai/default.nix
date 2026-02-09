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
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.amp
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.claude-code
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.codex
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.cursor-agent
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.droid
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
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
          "amp"
          "gemini-cli"
        ];
        casks = [
          "chatgpt"
          "claude"
          "claude-code"
          "cursor"
          "cursor-cli"
          "codex"
          "droid"
        ];
      };
    };
}
