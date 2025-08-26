{ inputs, pkgs, ... }:
{
  home.packages = [
    inputs.codex.packages.${pkgs.stdenv.hostPlatform.system}.codex-rs
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.claude-code
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.claude-desktop
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.gemini-cli
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.goose-cli
    inputs.nix-ai-tools.packages.${pkgs.stdenv.hostPlatform.system}.qwen-code
  ];

  home.file.".claude/CLAUDE.md".source = ./CLAUDE.md;
  home.file.".claude/agents".source = ./agents;

  programs.fish.shellAbbrs = {
    cc = {
      position = "command";
      setCursor = true;
      expansion = "claude -p \"%\"";
    };
    ccyolo = {
      position = "command";
      setCursor = true;
      expansion = "claude --dangerously-skip-permissions";
    };
  };
}
