{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "ai";

  home =
    { inputs, pkgs, ... }:
    {
      home.packages = pkgs.lib.optionals pkgs.stdenv.isLinux [
        pkgs.code-cursor-fhs

        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.codex
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.cursor-agent
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
        inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.qwen-code
      ];

      programs.fish.shellAbbrs = {
        codex = {
          position = "command";
          setCursor = true;
          expansion = "codex --search --full-auto";
        };
      };
    };

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [
          "chatgpt"
          "claude-code"
          "codex"
          "cursor"
          "cursor-cli"
          "gemini-cli"
        ];
      };
    };
}
