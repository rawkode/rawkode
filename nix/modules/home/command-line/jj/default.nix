{ config, lib, pkgs, ... }:

let
  cfg = config.programs.jj;
in
{
  options.programs.jj = {
    enable = lib.mkEnableOption "Jujutsu version control system";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.jujutsu;
      description = "The jujutsu package to use";
    };
    
    userName = lib.mkOption {
      type = lib.types.str;
      default = config.programs.git.userName or "Your Name";
      description = "Default user name for commits";
    };
    
    userEmail = lib.mkOption {
      type = lib.types.str;
      default = config.programs.git.userEmail or "you@example.com";
      description = "Default user email for commits";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."jj/config.toml".text = ''
[user]
name = "${cfg.userName}"
email = "${cfg.userEmail}"

[ui]
default-command = ["log"]
diff-editor = ":builtin"
paginate = "auto"

[revsets]
log = "ancestors(visible_heads(), 2) | trunk()"
    '';

    # Shell aliases
    programs.bash.shellAliases = lib.mkIf config.programs.bash.enable {
      j = "jj";
    };

    programs.fish.shellAliases = lib.mkIf config.programs.fish.enable {
      j = "jj";
    };

    programs.zsh.shellAliases = lib.mkIf config.programs.zsh.enable {
      j = "jj";
    };
  };
}