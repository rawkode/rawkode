{ pkgs, ... }:
{
  home.packages = with pkgs; [
    claude-code
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
