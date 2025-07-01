{ pkgs, ... }:
{
  home.packages = with pkgs; [
    claude-code
  ];

  xdg.configFile."claude/CLAUDE.md".source = ./CLAUDE.md;

  programs.fish.shellAbbrs = {
    cc = {
      position = "command";
      setCursor = true;
      expansion = "claude -p \"%\"";
    };
  };
}
