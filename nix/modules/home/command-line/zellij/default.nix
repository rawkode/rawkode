{ lib, pkgs, ... }:
{
  programs.zellij = {
    enable = true;

    settings = {
      default_shell = "${lib.getExe pkgs.nushell}";
      default_mode = "normal";
      default_layout = "compact";
      mouse_mode = false;
      pane_frames = false;
      simplified_ui = false;
      ui = {
        pane_frames = {
          hide_session_name = true;
        };
      };
    };
  };

  programs.fish = {
    interactiveShellInit = ''
      zellij_tab_names
    '';

    functions = {
      zellij_tab_names = {
        onVariable = "PWD";
        body = ''
          if set -q ZELLIJ
            set tab_name $PWD
            if test "$tab_name" = "$HOME"
                set tab_name "~"
            else
                set tab_name (basename "$tab_name")
            end
            command nohup zellij action rename-tab $tab_name >/dev/null 2>&1 &
          end
        '';
      };
    };
  };
}
