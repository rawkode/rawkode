{ config, lib, pkgs, ... }:

let
  cfg = config.programs.ghostty;
in
{
  options.programs.ghostty = {
    enable = lib.mkEnableOption "Ghostty terminal emulator";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.ghostty;
      description = "The ghostty package to use";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."ghostty/config".text = ''
theme = dark:catppuccin-macchiato,light:catppuccin-latte

font-size = 16
font-family = "Monaspace Neon"

shell-integration = detect

mouse-hide-while-typing = true

clipboard-read = "allow"
clipboard-write = allow
copy-on-select = clipboard

clipboard-trim-trailing-spaces = true
clipboard-paste-protection = true

confirm-close-surface = false

background-opacity = 0.98

focus-follows-mouse = true
unfocused-split-opacity = 0.5

gtk-single-instance = true
gtk-titlebar = true

window-decoration = true
window-colorspace = display-p3

window-theme = "auto"

window-padding-x = 8
window-padding-y = 8
window-padding-balance = true

keybind = ctrl+page_up=unbind
keybind = ctrl+page_down=unbind
keybind = shift+enter=text:\n
    '';
  };
}