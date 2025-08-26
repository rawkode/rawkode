{ inputs, pkgs, ... }:
{
  programs.ghostty = {
    enable = true;
    package = inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default;

    enableBashIntegration = true;
    enableFishIntegration = true;

    settings = {
      shell-integration = "detect";

      mouse-hide-while-typing = true;

      clipboard-read = "allow";
      clipboard-write = "allow";
      copy-on-select = "clipboard";
      clipboard-trim-trailing-spaces = true;
      clipboard-paste-protection = true;

      confirm-close-surface = false;

      background-opacity = 0.98;

      focus-follows-mouse = true;

      # This fixes clicking links with control in zellij
      # I don't know why.
      mouse-shift-capture = false;

      unfocused-split-opacity = 0.5;

      gtk-single-instance = true;
      gtk-titlebar = true;

      window-decoration = true;
      window-colorspace = "display-p3";
      window-theme = "auto";
      window-padding-x = 8;
      window-padding-y = 8;
      window-padding-balance = true;

      # gtk-tabs-location = "hidden";

      keybind = [
        "ctrl+space=toggle_tab_overview"
        "ctrl+shift+p=toggle_command_palette"

        "alt+shift+backslash=new_split:right"
        "alt+backslash=new_split:down"

        "alt+arrow_down=goto_split:down"
        "alt+arrow_up=goto_split:up"
        "alt+arrow_left=goto_split:left"
        "alt+arrow_right=goto_split:right"

        "shift+enter=text:\n"
      ];
    };
  };
}
