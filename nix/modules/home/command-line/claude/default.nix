{ config, lib, pkgs, ... }:

let
  cfg = config.programs.claude;
in
{
  options.programs.claude = {
    enable = lib.mkEnableOption "Claude AI CLI integration";
    
    claudeMdFile = lib.mkOption {
      type = lib.types.path;
      description = "Path to CLAUDE.md file with personas and rules";
    };
  };

  config = lib.mkIf cfg.enable {
    # Copy CLAUDE.md to the expected location
    xdg.configFile."claude/CLAUDE.md".source = cfg.claudeMdFile;

    # Fish abbreviation for claude
    programs.fish.shellAbbrs = lib.mkIf config.programs.fish.enable {
      cc = {
        position = "command";
        setCursor = true;
        expansion = "claude -p \"%\"";
      };
    };

    # Bash alias
    programs.bash.shellAliases = lib.mkIf config.programs.bash.enable {
      cc = "claude -p";
    };

    # Zsh alias
    programs.zsh.shellAliases = lib.mkIf config.programs.zsh.enable {
      cc = "claude -p";
    };
  };
}